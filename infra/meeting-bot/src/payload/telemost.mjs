/**
 * Сценарий страницы Телемоста.
 *
 * Внедряется ДО скриптов площадки: перехватывать `getUserMedia` и
 * `RTCPeerConnection` после того, как страница ими воспользовалась, поздно.
 *
 * Отвечает за четыре вещи, и все четыре проверены живыми встречами 14–15.09.2026
 * (подробности и грабли — в `infra/attendee/README.md`):
 *
 *   1. Микрофон бота — подменённая дорожка из нашего аудиографа. Телемост
 *      берёт её как есть, кликать по кнопке микрофона не нужно.
 *   2. Входящий звук — дорожки участников сводятся в один поток и уезжают
 *      наружу кадрами Float32.
 *   3. Состав — по счётчику площадки: имён в разметке нет вовсе, плитки
 *      участников пустые.
 *   4. Чат — читается в кадре Яндекс Мессенджера и передаётся родителю через
 *      postMessage. Писать нельзя: гостю площадка показывает «Войдите, чтобы
 *      написать сообщение».
 *
 * Наружу всё уходит одним способом — через `window.__botSend(тип, данные)`,
 * который сервис подставляет со своей стороны (`page.exposeFunction`). Так
 * страница не знает ни про вебсокеты, ни про вебхуки.
 */
export const TELEMOST_PAYLOAD = `
(() => {
  const send = (type, data) => {
    try { window.__botSend(type, data); } catch (e) { /* канал ещё не готов */ }
  };

  // ── Кадр чата: только чтение, наружу через родителя ──────────────────────
  if (location.host === 'yandex.ru' && location.pathname.startsWith('/chat')) {
    const seen = new Set();
    let started = false;

    // Автор строки. Подряд идущие сообщения мессенджер группирует, и заголовок
    // с именем стоит только на первой строке группы — идём назад по всему
    // списку строк. Роль («Администратор») в innerText склеена с именем,
    // отрезаем её.
    const authorFor = (node) => {
      const row = node.closest('.yamb-message-row');
      if (!row) return 'участник';
      const rows = [...document.querySelectorAll('.yamb-message-row')];
      for (let i = rows.indexOf(row); i >= 0; i--) {
        const nameEl = rows[i].querySelector('.yamb-message-user__name');
        if (!nameEl) continue;
        const full = (nameEl.innerText || '').replace(/\\s+/g, ' ').trim();
        const roleEl = rows[i].querySelector('.yamb-message-user__additional-text');
        const role = roleEl ? (roleEl.innerText || '').trim() : '';
        const name = role && full.endsWith(role) ? full.slice(0, full.length - role.length).trim() : full;
        if (name) return name;
      }
      return 'участник';
    };

    setInterval(() => {
      try {
        for (const span of document.querySelectorAll('.yamb-message-text span.text[id$="_c"]')) {
          const id = span.id.replace(/_c$/, '');
          if (seen.has(id)) continue;
          const text = (span.innerText || '').replace(/\\s+/g, ' ').trim();
          if (!text) continue;
          seen.add(id);
          // Первый проход — история до нашего прихода: её пересылать нельзя,
          // это не обращения к ассистенту.
          if (!started) continue;
          window.parent.postMessage(
            { __bot: 'chat', id, text, author: authorFor(span) },
            '*',
          );
        }
        started = true;
      } catch (e) { console.error('[бот] чат не прочитался', e); }
    }, 1500);
    return;
  }

  // ── Кадр встречи ────────────────────────────────────────────────────────

  // Микрофон: приложение получает не устройство, а дорожку из нашего графа.
  let ctx = null, dest = null, gain = null, micTrack = null;
  const ensureMic = () => {
    if (micTrack) return micTrack;
    ctx = new AudioContext({ sampleRate: 48000 });
    dest = ctx.createMediaStreamDestination();
    gain = ctx.createGain();
    gain.gain.value = 1;
    gain.connect(dest);
    micTrack = dest.stream.getAudioTracks()[0];
    window.__botMicContext = ctx;
    window.__botMicGain = gain;
    return micTrack;
  };

  const origGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async function (constraints) {
    const wantAudio = !!(constraints && constraints.audio);
    const wantVideo = !!(constraints && constraints.video);
    const stream = new MediaStream();
    if (wantAudio) stream.addTrack(ensureMic().clone());
    if (wantVideo) {
      // Пустой холст вместо камеры: настоящую мы не отдаём, а отказ ломает
      // вход на площадках, которые просят видео вместе со звуком.
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 640; canvas.height = 360;
        stream.addTrack(canvas.captureStream(5).getVideoTracks()[0]);
      } catch (e) { console.error('[бот] холст не сделался', e); }
    }
    if (!wantAudio && !wantVideo) return origGum(constraints);
    send('gum', { audio: wantAudio, video: wantVideo });
    return stream;
  };

  // Голос ассистента: сервис зовёт эту функцию с куском PCM16 в base64 — той
  // самой строкой, что пришла от воркера. Разбирать её здесь дешевле, чем
  // тащить через мост CDP массив чисел.
  window.__botPlayPcm = (chunk) => {
    const c = ctx || (ensureMic(), ctx);
    const raw = atob(chunk);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const pcm = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) float32[i] = pcm[i] / 32768;
    const buf = c.createBuffer(1, float32.length, 24000);
    buf.getChannelData(0).set(float32);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(gain);
    // Склейка встык: кусок ставится сразу за предыдущим, иначе между ними
    // слышны щелчки, а при отставании речь рвётся.
    const now = c.currentTime;
    window.__botNextAt = Math.max(window.__botNextAt || 0, now);
    src.start(window.__botNextAt);
    window.__botNextAt += buf.duration;
  };

  // Входящий звук: дорожки участников в один микс.
  //
  // Контекст на 24 кГц — не вкус, а условие: столько объявляет наш протокол
  // воркеру, и он читает куски именно так, не глядя на поле sample_rate.
  // Первая редакция сводила на 48 кГц и отдавала под ярлыком 24 — ассистент
  // слышал вдвое замедленную речь и почти ничего не разбирал (живая встреча
  // 15.09.2026). У Attendee частоту приводил сам мост; своему боту делать это
  // некому, а браузер пересчитает лучше нас — своим ресемплером и даром.
  const mixCtx = new AudioContext({ sampleRate: 24000 });
  const mixDest = mixCtx.createMediaStreamDestination();
  const heard = new Set();
  let pumping = false;

  const b64 = (pcm) => {
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let s = '';
    // По кускам: apply на всём массиве переполняет стек аргументов.
    for (let i = 0; i < bytes.length; i += 8192) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    }
    return btoa(s);
  };

  const startPump = () => {
    if (pumping) return;
    const track = mixDest.stream.getAudioTracks()[0];
    if (!track) return;
    pumping = true;

    // Копим 40 мс и отдаём одной строкой.
    //
    // Наружу из страницы ведёт мост CDP, и каждый вызов стоит сериализации.
    // Первая редакция гнала в него массив float на каждый кадр — около
    // полумегабайта JSON в секунду; звук приходил рвано просто потому, что
    // мост не успевал. PCM16 в base64 — в тридцать раз меньше.
    const BATCH = 960;
    let acc = new Int16Array(BATCH);
    let filled = 0;

    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        try {
          const data = new Float32Array(value.numberOfFrames);
          value.copyTo(data, { planeIndex: 0 });
          for (let i = 0; i < data.length; i++) {
            const v = Math.max(-1, Math.min(1, data[i]));
            acc[filled++] = Math.round(v * 32767);
            if (filled === BATCH) { send('audio', b64(acc)); filled = 0; }
          }
        } catch (e) { console.error('[бот] кадр не разобрался', e); }
        finally { value.close(); }
      }
    })().catch((e) => console.error('[бот] чтение звука прервалось', e));
  };

  const OrigPC = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...args) {
    const pc = Reflect.construct(OrigPC, args);
    pc.addEventListener('track', (ev) => {
      if (!ev.track || ev.track.kind !== 'audio' || heard.has(ev.track.id)) return;
      heard.add(ev.track.id);
      mixCtx.createMediaStreamSource(new MediaStream([ev.track])).connect(mixDest);
      send('tracks', { count: heard.size });
      startPump();
    });
    return pc;
  };
  window.RTCPeerConnection.prototype = OrigPC.prototype;

  // Состав: имён в разметке нет, есть счётчик на кнопке участников.
  //
  // Шлём КАЖДЫЙ раз, а не только при изменении: что из этого новость, решает
  // сервис — он один знает, что бэкенд подтвердил.
  setInterval(() => {
    try {
      const btn = document.querySelector('[data-testid="participants-button"]');
      if (!btn) return;
      const m = (btn.innerText || '').match(/\\d+/);
      if (!m) return;
      // Минус мы сами: площадка считает и бота.
      send('participants', { humans: Math.max(0, Number(m[0]) - 1) });
    } catch (e) { console.error('[бот] состав не прочитался', e); }
  }, 2000);

  // Сообщения из кадра чата.
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.__bot !== 'chat' || !d.text) return;
    send('chat', { id: String(d.id), text: String(d.text), author: String(d.author || 'участник') });
  });

  send('ready', { url: location.host + location.pathname });
})();
`;

/** Шаги входа. Разметка разведана 14–15.09.2026, см. README моста. */
export const TELEMOST_JOIN = {
  nameInput: 'input[type="text"], input[placeholder*="мя" i]',
  joinButton: 'button:has-text("Подключиться"), [role="button"]:has-text("Подключиться")',
  cameraOff: '[role="button"][aria-label*="камер" i]',
  inMeeting: 'button:has-text("Участники"), [role="button"]:has-text("Участники")',
  chatButton: '[data-testid="chat-alt-button"], button:has-text("Чат")',
  leaveButton: '[role="button"][aria-label*="Выйти" i], button[aria-label*="Выйти" i]',
};
