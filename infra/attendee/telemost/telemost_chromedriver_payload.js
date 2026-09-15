/**
 * Полезная нагрузка страницы Телемоста.
 *
 * Внедряется ДО скриптов площадки: перехватывать `RTCPeerConnection` после
 * того, как страница его создала, поздно.
 *
 * Отвечает за три вещи:
 *   1. Связь с мостом (вебсокет на localhost, тот же двоичный протокол, что у
 *      остальных веб-адаптеров: 4 байта типа, дальше данные).
 *   2. Входящий звук: дорожки участников сводятся в один поток и уезжают в
 *      мост кадрами Float32 на 48 кГц.
 *   3. Состав участников: снимаем со списка на странице и шлём `UsersUpdate` —
 *      на нём держатся правила выхода и наш гейт по имени.
 *
 * Исходящий звук делает НЕ этот файл, а общий `shared_chromedriver_payload.js`:
 * там живёт `BotOutputManager`, который подменяет `getUserMedia`. Спайк
 * 14.09.2026 показал, что Телемост берёт подменённую дорожку как есть, без
 * единого клика по микрофону, — поэтому здесь ни одной правки на этот счёт.
 */

class TelemostWebSocketClient {
  static MESSAGE_TYPES = { JSON: 1, VIDEO: 2, AUDIO: 3 };

  constructor() {
    const url = `ws://localhost:${window.initialData.websocketPort}`;
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.mediaSendingEnabled = false;
    this.ws.onopen = () => {
      console.log('[телемост] мост на связи');
      // Сигнал в лог моста: без него «страница молчит» и «страница не
      // подключилась» выглядят одинаково, а это разные поломки.
      this.sendJson({ type: 'TelemostDebug', event: 'ws_open', port: window.initialData.websocketPort });
    };
    this.ws.onerror = (e) => console.error('[телемост] ошибка вебсокета', e);
    this.ws.onclose = () => console.log('[телемост] мост отключился');
  }

  async enableMediaSending() {
    this.mediaSendingEnabled = true;
    this.sendJson({
      type: 'TelemostDebug',
      event: 'media_enabled',
      mixerStarted: !!window.telemostMixer?.started,
      tracks: window.telemostMixer ? window.telemostMixer.tracks.size : -1,
    });
  }

  async disableMediaSending() {
    // Даём мосту дослать последние кадры: обрыв на полуслове режет последнюю
    // фразу участника, а она обычно и есть самая нужная.
    await new Promise((r) => setTimeout(r, 1000));
    this.mediaSendingEnabled = false;
  }

  sendJson(data) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(data));
      const message = new Uint8Array(4 + bytes.length);
      new DataView(message.buffer).setInt32(0, TelemostWebSocketClient.MESSAGE_TYPES.JSON, true);
      message.set(bytes, 4);
      this.ws.send(message.buffer);
    } catch (e) {
      console.error('[телемост] не отправилось', e, data);
    }
  }

  sendMixedAudio(audioData) {
    if (this.ws.readyState !== WebSocket.OPEN || !this.mediaSendingEnabled) return;
    try {
      const message = new Uint8Array(4 + audioData.buffer.byteLength);
      new DataView(message.buffer).setInt32(0, TelemostWebSocketClient.MESSAGE_TYPES.AUDIO, true);
      message.set(new Uint8Array(audioData.buffer), 4);
      this.ws.send(message.buffer);
    } catch (e) {
      console.error('[телемост] звук не отправился', e);
    }
  }
}

/**
 * Сведение входящего звука.
 *
 * Берём дорожки прямо из `ontrack`, а не из аудиоэлементов страницы: спайк
 * показал, что Телемост отдаёт участников отдельными дорожками, и это самый
 * прямой источник — он не зависит от того, как именно площадка их проигрывает.
 *
 * Свой же звук в микс не попадает: наша дорожка уходит отправителем и в
 * `ontrack` не приходит.
 */
class TelemostAudioMixer {
  constructor(ws) {
    this.ws = ws;
    this.ctx = new AudioContext({ sampleRate: 48000 });
    this.destination = this.ctx.createMediaStreamDestination();
    this.started = false;
    this.tracks = new Set();
  }

  addTrack(track) {
    if (track.kind !== 'audio' || this.tracks.has(track.id)) return;
    this.tracks.add(track.id);
    const source = this.ctx.createMediaStreamSource(new MediaStream([track]));
    source.connect(this.destination);
    console.log('[телемост] дорожка участника в миксе, всего:', this.tracks.size);
    this.start();
  }

  start() {
    if (this.started) return;
    const mixed = this.destination.stream.getAudioTracks()[0];
    if (!mixed) return;
    this.started = true;

    // MediaStreamTrackProcessor — тот же приём, которым Attendee снимает звук
    // у Zoom-web: даёт сырые кадры без записи в файл и без задержки кодека.
    const processor = new MediaStreamTrackProcessor({ track: mixed });
    const reader = processor.readable.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        try {
          const frames = value.numberOfFrames;
          const data = new Float32Array(frames);
          value.copyTo(data, { planeIndex: 0 });
          this.ws.sendMixedAudio(data);
        } catch (e) {
          console.error('[телемост] кадр не разобрался', e);
        } finally {
          value.close();
        }
      }
    };
    pump().catch((e) => console.error('[телемост] чтение звука прервалось', e));
    console.log('[телемост] сведение звука запущено');
  }
}

/**
 * Состав участников.
 *
 * Телемост не даёт нам своего API, поэтому читаем список со страницы. Опрос
 * раз в две секунды: событий об уходе у нас нет, а держать правила выхода на
 * чём-то надо. Личности берём по видимому имени — это приближение, и при двух
 * тёзках они сольются в одного; лучше так, чем не знать состава вовсе.
 */
class TelemostParticipants {
  constructor(ws) {
    this.ws = ws;
    this.current = new Map();
  }

  read() {
    const names = new Set();
    // Подписи под плитками участников. Берём по атрибуту, а не по классу:
    // классы у Телемоста собраны сборщиком и меняются от выката к выкату.
    for (const el of document.querySelectorAll('[data-testid*="participant"], [class*="participant"]')) {
      const text = (el.innerText || '').trim().split('\n')[0];
      if (text && text.length < 64) names.add(text);
    }
    return names;
  }

  tick() {
    const names = this.read();
    const seen = new Map();
    for (const name of names) {
      const id = `telemost-${name}`;
      seen.set(id, {
        deviceId: id,
        displayName: name,
        fullName: name,
        profile: '',
        status: 'in_meeting',
        humanized_status: 'in_meeting',
        isCurrentUser: name === window.telemostInitialData?.displayName,
      });
    }

    const newUsers = [...seen.values()].filter((u) => !this.current.has(u.deviceId));
    const removedUsers = [...this.current.values()]
      .filter((u) => !seen.has(u.deviceId))
      .map((u) => ({ ...u, status: 'not_in_meeting', humanized_status: 'not_in_meeting' }));

    if (newUsers.length || removedUsers.length) {
      this.current = seen;
      this.ws.sendJson({ type: 'UsersUpdate', newUsers, removedUsers, updatedUsers: [] });
      console.log('[телемост] состав:', [...seen.values()].map((u) => u.displayName).join(', ') || 'пусто');
    }
  }

  start() {
    setInterval(() => {
      try { this.tick(); } catch (e) { console.error('[телемост] состав не прочитался', e); }
    }, 2000);
  }
}

// ── Сборка ────────────────────────────────────────────────────────────────
//
// Целиком под try/catch: исключение здесь оставило бы `window.ws`
// неопределённым, и мост не смог бы ни принять звук, ни отдать его — со
// стороны это выглядит как «бот пришёл и молчит», без единой строки о причине.

try {
  const ws = new TelemostWebSocketClient();
  window.ws = ws;

  const telemostMixer = new TelemostAudioMixer(ws);
  window.telemostMixer = telemostMixer;

  const OrigPC = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...args) {
    const pc = Reflect.construct(OrigPC, args);
    pc.addEventListener('track', (ev) => {
      if (ev.track && ev.track.kind === 'audio') {
        telemostMixer.addTrack(ev.track);
        ws.sendJson({ type: 'TelemostDebug', event: 'incoming_track', tracks: telemostMixer.tracks.size });
      }
    });
    return pc;
  };
  window.RTCPeerConnection.prototype = OrigPC.prototype;

  // Микрофон бота. Общий BotOutputManager сам подменит getUserMedia; клики по
  // кнопке микрофона Телемосту не нужны (проверено спайком), поэтому колбэки
  // пустые — но объект создаём, иначе исходящий звук отправлять некому.
  window.botOutputManager = new BotOutputManager({
    turnOnMic: () => {},
    turnOffMic: () => {},
    turnOnWebcam: () => {},
    turnOffWebcam: () => {},
    turnOnScreenshare: () => {},
    turnOffScreenshare: () => {},
  });

  new TelemostParticipants(ws).start();
  console.log('[телемост] нагрузка страницы установлена');
} catch (e) {
  // До моста такое сообщение доедет только если ws успел подняться; если нет —
  // останется хотя бы в консоли страницы и на снимке экрана.
  console.error('[телемост] нагрузка НЕ установилась:', e);
  try {
    window.ws?.sendJson({ type: 'TelemostDebug', event: 'payload_failed', error: String(e && e.message || e) });
  } catch (_) { /* канала нет — ничего не поделать */ }
}
