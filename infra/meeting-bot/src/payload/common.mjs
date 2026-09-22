/**
 * Общая часть сценария страницы: звук.
 *
 * Микрофон бота, сведение голосов участников и проигрывание голоса ассистента
 * устроены на всех площадках ОДИНАКОВО — потому что это не про площадку, а про
 * браузер: подменённая дорожка из аудиографа, `ontrack` у соединения и
 * `MediaStreamTrackProcessor` на выходе микса. Различается только то, как
 * войти во встречу и где взять состав с чатом.
 *
 * Куски здесь — не готовые модули, а ТЕКСТ, который платформа вставляет в своё
 * тело сценария. Иначе никак: сценарий уезжает в браузер строкой и живёт там
 * одной функцией, где `send` и микрофон общие для всех частей.
 *
 * Наружу всё уходит через `window.__botSend(тип, данные)` — его подставляет
 * сервис (`page.exposeFunction`). Страница не знает ни про вебсокеты, ни про
 * вебхуки.
 */

/** Отправка наружу. Объявляется первой строкой тела сценария. */
export const SEND_HELPER = `
  const send = (type, data) => {
    try { window.__botSend(type, data); } catch (e) { /* канал ещё не готов */ }
  };
`;

/**
 * Звук в обе стороны.
 *
 * Требует, чтобы `send` был объявлен выше.
 */
export const AUDIO_PART = `
  // ── Микрофон: приложение получает не устройство, а дорожку из нашего графа ─
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
    // Метка «микрофон отдали здесь».
    //
    // Сценарий работает во всех кадрах страницы, а микрофон у площадки просит
    // только один из них. Голос ассистента надо проигрывать именно в его
    // аудиограф: в соседнем кадре граф есть, но он ни к чему не подключён, и
    // речь уходит в пустоту — ровно это и случилось на новом Телемосте, где
    // встреча живёт в дочернем кадре (22.09.2026).
    if (wantAudio) window.__botMicServed = true;
    send('gum', { audio: wantAudio, video: wantVideo });
    return stream;
  };

  // ── Голос ассистента ─────────────────────────────────────────────────────
  //
  // Сервис зовёт эту функцию куском PCM16 в base64 — той самой строкой, что
  // пришла от воркера. Разбирать её здесь дешевле, чем тащить через мост CDP
  // массив чисел.
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

  // ── Входящий звук: дорожки участников в один микс ────────────────────────
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
    const acc = new Int16Array(BATCH);
    let filled = 0;
    let frames = 0;
    let peak = 0;

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
            if (v > peak) peak = v;
            acc[filled++] = Math.round(v * 32767);
            if (filled === BATCH) { send('audio', b64(acc)); filled = 0; }
          }
          // Раз в пять секунд — насколько громко было (кадр идёт каждые 10 мс).
          //
          // Без этого «никто не говорит» и «звук до нас не доходит» выглядят
          // в логе одинаково: куски идут в обоих случаях, потому что поток
          // непрерывен. На Телемосте это стоило нам двух заходов вслепую.
          if (++frames % 500 === 0) { send('level', { peak: Math.round(peak * 100) }); peak = 0; }
        } catch (e) { console.error('[бот] кадр не разобрался', e); }
        finally { value.close(); }
      }
    })().catch((e) => console.error('[бот] чтение звука прервалось', e));
  };

  // Дорожки берём у соединения, а не у аудиоэлементов страницы: так работают
  // и Телемост, и клиент Zoom, и это не зависит от того, как площадка решила
  // их проигрывать. Своя дорожка сюда не попадает — она уходит отправителем.
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
`;
