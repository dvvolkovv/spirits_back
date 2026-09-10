/**
 * Спайк: синхронизация встречи в комнату LiveKit вместо вебсокета.
 *
 * ЗАЧЕМ. Сейчас звук встречи ходит нашим вебсокетом (AttendeeAudioHub), и из
 * этого выросли: порт на задание и потолок в одну встречу, переподключения,
 * вранье о составе через вебхуки, отсутствие диаризации и перебивание без
 * сброса очереди. У моста есть режим, который всё это снимает: он зеркалит
 * КАЖДОГО участника встречи отдельным участником LiveKit с моно-дорожкой, чат
 * кладёт в дата-канал, а звук ассистента берёт у участника комнаты, указанного
 * по `identity` или по `publish_on_behalf` (паттерн агента LiveKit).
 *
 * Если это работает, путь Meet и Zoom становится тем же путём, что уже обкатан
 * на Taler ID, — то есть нашей ветки с вебсокетом не нужно вовсе.
 *
 * ЧТО ПРОВЕРЯЕТ:
 *   1. появляются ли участники встречи в комнате LiveKit и с какими именами;
 *   2. идёт ли их звук — по каждой дорожке отдельно, с RMS, чтобы отличить
 *      живую речь от тишины (та же мера, что в zoom-spike.cjs);
 *   3. доходит ли ДО встречи звук, который мы публикуем в комнату: скрипт
 *      публикует тон 440 Гц через двадцать секунд после старта;
 *   4. зеркалится ли чат встречи — он приходит текстовым потоком на топик
 *      `lk.chat`, а не сообщением дата-канала.
 *
 * ЗАПУСК на стенде (комната создаётся сама, ссылка на встречу — аргумент):
 *
 *   cd ~/spirits_back/voice-host && NODE_PATH=$PWD/node_modules \
 *     node -r dotenv/config ~/roomsync-spike.cjs "https://meet.google.com/abc-defg-hij"
 *
 * Требует ключей LiveKit в проекте моста (тип credentials LiveKit) с адресом,
 * достижимым ИЗ КОНТЕЙНЕРА: на стенде это ws://172.17.0.1:7880, а не
 * ws://localhost:7880, который у моста означал бы его собственный контейнер.
 */

const { AccessToken } = require('livekit-server-sdk');
const { Room, RoomEvent, AudioSource, LocalAudioTrack, TrackPublishOptions, TrackSource, AudioStream, AudioFrame } = require('@livekit/rtc-node');

const meetingUrl = process.argv[2];
if (!meetingUrl) {
  console.error('нужна ссылка на встречу');
  process.exit(1);
}

const LK_URL = process.env.LIVEKIT_URL || 'ws://localhost:7880';
const LK_KEY = process.env.LIVEKIT_API_KEY;
const LK_SECRET = process.env.LIVEKIT_API_SECRET;
const ATTENDEE = (process.env.ATTENDEE_BASE_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
const ATTENDEE_KEY = process.env.ATTENDEE_API_KEY;
if (!LK_KEY || !LK_SECRET || !ATTENDEE_KEY) {
  console.error('нужны LIVEKIT_API_KEY, LIVEKIT_API_SECRET и ATTENDEE_API_KEY в окружении');
  process.exit(1);
}

/** Наша личность в комнате: у неё мост и будет брать звук для встречи. */
const AGENT_IDENTITY = 'linkeon-agent';
const ROOM = `roomsync-${Date.now()}`;
const SAMPLE_RATE = 48_000;          // родная частота зеркалирования у моста
/** Пауза между повторами тона: три попытки, чтобы не гонять встречу заново. */
const TONE_REPEAT_MS = 20_000;
const TONE_MS = 3_000;
const TONE_HZ = 440;

/** Уровень куска: отличает живую речь от ровной тишины. */
function rms(frame) {
  const d = frame.data;
  if (!d.length) return 0;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    const s = d[i] / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / d.length);
}

async function token(identity, canPublish) {
  const t = new AccessToken(LK_KEY, LK_SECRET, { identity, name: 'Роман (спайк)' });
  t.addGrant({ roomJoin: true, room: ROOM, canPublish, canSubscribe: true, canPublishData: true });
  return await t.toJwt();
}

async function api(path, init = {}) {
  const res = await fetch(`${ATTENDEE}${path}`, {
    ...init,
    headers: { Authorization: `Token ${ATTENDEE_KEY}`, 'Content-Type': 'application/json' },
  });
  let data = null;
  try { data = await res.json(); } catch { /* тела может не быть */ }
  return { status: res.status, data };
}

const heard = new Map();   // identity → { chunks, rmsMax }

async function main() {
  const room = new Room();

  room.on(RoomEvent.ParticipantConnected, (p) => {
    console.log(`[комната] участник появился: identity=${p.identity} name=${p.name || '—'}`);
  });
  room.on(RoomEvent.ParticipantDisconnected, (p) => {
    console.log(`[комната] участник ушёл: ${p.identity}`);
  });
  room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
    const text = new TextDecoder().decode(payload).slice(0, 300);
    console.log(`[данные] от ${participant?.identity || '—'} topic=${topic || '—'}: ${text}`);
  });

  // Чат встречи приезжает ТЕКСТОВЫМ ПОТОКОМ на топик `lk.chat`, а не
  // сообщением дата-канала: мост зовёт `send_text(text, topic="lk.chat")` —
  // это конвенция LiveKit, которую их же клиенты показывают как чат.
  //
  // Первая редакция спайка слушала только DataReceived и не увидела ни одного
  // сообщения, хотя мост их поймал (десять упоминаний ChatMessage в его логе).
  // Прогон 10.09.2026: вывод «чат не зеркалится» был неверным, и виноват был
  // спайк, а не мост.
  room.registerTextStreamHandler('lk.chat', async (reader, participantIdentity) => {
    try {
      const text = await reader.readAll();
      console.log(`[чат] ${participantIdentity}: ${String(text).slice(0, 300)}`);
    } catch (e) {
      console.log(`[чат] не прочитался: ${e?.message}`);
    }
  });
  room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
    console.log(`[дорожка] подписались: ${participant.identity} kind=${track.kind}`);
    const id = participant.identity;
    heard.set(id, { chunks: 0, rmsMax: 0 });
    // Читаем поток в фоне: нам нужен только факт звука и его уровень.
    void (async () => {
      // Через getReader, а не for-await: ровно так читает дорожки наш
      // mixed-audio-input.ts на установленной версии @livekit/rtc-node.
      const reader = new AudioStream(track, SAMPLE_RATE, 1).getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const st = heard.get(id);
          if (!st) break;
          st.chunks++;
          const level = rms(value);
          if (level > st.rmsMax) st.rmsMax = level;
        }
      } catch (e) {
        console.log(`[дорожка] чтение ${id} прервано: ${e?.message}`);
      }
    })();
  });

  await room.connect(LK_URL, await token(AGENT_IDENTITY, true), { autoSubscribe: true, dynacast: false });
  console.log(`[комната] ${ROOM} подключена как ${AGENT_IDENTITY}`);

  // Дорожку публикуем сразу: мост подписывается на неё при входе, и молчащая
  // дорожка ему не мешает.
  const source = new AudioSource(SAMPLE_RATE, 1);
  const track = LocalAudioTrack.createAudioTrack('agent-voice', source);
  const opts = new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE });
  await room.localParticipant.publishTrack(track, opts);
  console.log('[комната] дорожка ассистента опубликована');

  const bot = await api('/api/v1/bots', {
    method: 'POST',
    body: JSON.stringify({
      meeting_url: meetingUrl,
      bot_name: 'Роман · ассистент (спайк)',
      metadata: { callId: ROOM },
      recording_settings: { format: 'none' },
      automatic_leave_settings: {
        only_participant_in_meeting_timeout_seconds: 300,
        silence_timeout_seconds: 1800,
        max_uptime_seconds: 1200,
      },
      // Ни слова про websocket_settings: в этом и смысл спайка — проверить
      // путь, где звук ходит через комнату, а не через наш вебсокет.
      room_sync_settings: {
        sync_to_room: true,
        livekit: {
          room_name: ROOM,
          // Звук ассистента мост возьмёт у нашей личности. Второй вариант —
          // publish_on_behalf, им пользуется агент LiveKit, публикующий за
          // другого участника; для спайка identity проще и однозначнее.
          source_participant: { identity: AGENT_IDENTITY },
        },
      },
      ...(process.env.ZOOM_SDK === 'web' ? { zoom_settings: { sdk: 'web' } } : {}),
    }),
  });
  if (bot.status < 200 || bot.status >= 300) {
    console.error(`[bot] создать не удалось: HTTP ${bot.status}`, JSON.stringify(bot.data).slice(0, 500));
    process.exit(1);
  }
  const botId = bot.data.id;
  console.log(`[bot] создан ${botId}, состояние ${bot.data.state}`);

  // Тон — ПО СОБЫТИЮ входа, а не по часам.
  //
  // Первая редакция публиковала его через двадцать секунд после старта, и на
  // первом же прогоне (Teams, 10.09.2026) он ушёл в пустоту: бот входил
  // пятьдесят пять секунд, а таймер сработал на двадцатой. Проверка
  // обратного пути тогда просто не состоялась, и это выяснилось только по
  // логу — худший вид непроверенной проверки.
  //
  // Повторяем несколько раз с паузой: человек может отвлечься, а спрашивать
  // «слышно?» дешевле, чем гонять встречу заново.
  let tonesLeft = 3;
  let toneTimer = null;

  let last = '';
  const timer = setInterval(async () => {
    const r = await api(`/api/v1/bots/${botId}`);
    const st = r.data?.state ?? `HTTP ${r.status}`;
    if (st !== last) {
      last = st;
      console.log(`[bot] состояние: ${st}`);
      if (st === 'joined_recording' && !toneTimer) {
        // Вошёл и слышит встречу — теперь есть смысл говорить.
        void sendTone(source);
        tonesLeft--;
        toneTimer = setInterval(() => {
          if (tonesLeft-- <= 0) { clearInterval(toneTimer); return; }
          void sendTone(source);
        }, TONE_REPEAT_MS);
        toneTimer.unref?.();
      }
      if (['ended', 'fatal_error', 'data_deleted'].includes(st)) {
        clearInterval(timer);
        summary();
        await room.disconnect();
        process.exit(0);
      }
    }
    const who = [...heard.entries()]
      .map(([id, s]) => `${id}: кусков ${s.chunks}, RMS макс ${s.rmsMax.toFixed(4)}`)
      .join(' | ') || 'дорожек нет';
    console.log(`[звук] ${who}`);
  }, 5_000);

  process.on('SIGINT', async () => {
    console.log('\n[bot] убираю бота');
    await api(`/api/v1/bots/${botId}/leave`, { method: 'POST' }).catch(() => {});
    summary();
    await room.disconnect();
    process.exit(0);
  });
}

/** Тон в комнату: если он слышен во встрече, обратный путь работает. */
async function sendTone(source) {
  const samples = SAMPLE_RATE / 50;      // 20 мс
  const frames = Math.round(TONE_MS / 20);
  console.log(`[тон] публикую ${TONE_HZ} Гц, ${TONE_MS / 1000}с — слушайте во встрече`);
  for (let n = 0; n < frames; n++) {
    const pcm = new Int16Array(samples);
    for (let i = 0; i < samples; i++) {
      const t = (n * samples + i) / SAMPLE_RATE;
      pcm[i] = Math.round(Math.sin(2 * Math.PI * TONE_HZ * t) * 0.3 * 32767);
    }
    // captureFrame сам держит темп реального времени — ровно то, чего не
    // делает наш вебсокетный вывод (отсюда и проблема с перебиванием).
    await source.captureFrame(new AudioFrame(pcm, SAMPLE_RATE, 1, samples));
  }
  console.log('[тон] отправлен');
}

function summary() {
  console.log('=== ИТОГ ===');
  if (!heard.size) {
    console.log('дорожек участников не появилось — зеркалирование не сработало');
    return;
  }
  for (const [id, s] of heard) {
    console.log(`${id}: кусков ${s.chunks}, RMS макс ${s.rmsMax.toFixed(4)} — ${s.rmsMax > 0.001 ? 'звук ЖИВОЙ' : 'ТИШИНА'}`);
  }
}

main().catch((e) => { console.error('спайк упал:', e); process.exit(1); });
