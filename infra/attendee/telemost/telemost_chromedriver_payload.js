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
 * Имён у Телемоста в разметке НЕТ: плитки участников (`participant-video-
 * placeholder`) пустые, подписи рисуются поверх видео. Разведка 15.09.2026
 * это показала — первая редакция читала «всё, что похоже на участника», и
 * приносила мусор: «Ваше имя на встрече» и склеенное «ГостьРоман · ассистент
 * пользователя». На таком составе не работают ни гейт по имени, ни правила
 * выхода.
 *
 * Зато есть ЧИСЛО: кнопка `participants-button` показывает количество. По нему
 * и ведём состав — честно и без выдуманных имён. Люди получают безличные
 * подписи «Участник N»: разметка говорящего у этой площадки всё равно не
 * работает (событий речи адаптер не даёт), а числа хватает и правилам выхода,
 * и гейту, который по числу решает, наедине ли ассистент.
 *
 * Себя в счётчике учитываем: бот — тоже участник, и Телемост считает его.
 */
class TelemostParticipants {
  constructor(ws) {
    this.ws = ws;
    this.count = 0;
  }

  /** Сколько участников показывает площадка, включая нас. Null — не прочиталось. */
  read() {
    const btn = document.querySelector('[data-testid="participants-button"]');
    if (!btn) return null;
    const m = (btn.innerText || '').match(/\d+/);
    return m ? Number(m[0]) : null;
  }

  user(i) {
    return {
      deviceId: `telemost-participant-${i}`,
      displayName: `Участник ${i}`,
      fullName: `Участник ${i}`,
      profile: '',
      status: 'in_meeting',
      humanized_status: 'in_meeting',
      isCurrentUser: false,
    };
  }

  tick() {
    const total = this.read();
    if (total === null) return;
    // Минус мы сами: мост считает людей, а бот в их число не входит.
    const humans = Math.max(0, total - 1);
    if (humans === this.count) return;

    const newUsers = [];
    const removedUsers = [];
    for (let i = this.count + 1; i <= humans; i++) newUsers.push(this.user(i));
    for (let i = humans + 1; i <= this.count; i++) {
      removedUsers.push({ ...this.user(i), status: 'not_in_meeting', humanized_status: 'not_in_meeting' });
    }
    this.count = humans;
    this.ws.sendJson({ type: 'UsersUpdate', newUsers, removedUsers, updatedUsers: [] });
    console.log('[телемост] людей во встрече:', humans);
  }

  start() {
    setInterval(() => {
      try { this.tick(); } catch (e) { console.error('[телемост] состав не прочитался', e); }
    }, 2000);
  }
}


/**
 * Чтение чата встречи.
 *
 * Чат у Телемоста — отдельный кадр Яндекс Мессенджера
 * (`yandex.ru/chat?…&build=telemost`), а не часть страницы встречи. Наша
 * нагрузка внедряется во ВСЕ кадры, поэтому читаем прямо там, а наружу отдаём
 * через `postMessage` родителю: вебсокет к мосту держит только главный кадр,
 * и заводить второй ради чата незачем.
 *
 * ПИСАТЬ НЕЛЬЗЯ. Гостю Телемост показывает вместо поля ввода кнопку «Войдите,
 * чтобы написать сообщение» — для записи боту нужен аккаунт Яндекса. Поэтому
 * здесь только чтение, а инструмент записи для этой площадки у ассистента
 * снят: обещать то, чего нет, хуже, чем не уметь.
 *
 * Разметка разведана 15.09.2026 (`infra/attendee/chatdom2-probe.mjs`):
 *   .yamb-message-row            — строка сообщения
 *   .yamb-message-user__name     — автор (у подряд идущих сообщений он один
 *                                  на группу, поэтому ищем назад по строкам)
 *   .yamb-message-text span.text — текст, id вида `1789465432012070_c`
 */
class TelemostChatReader {
  constructor(send) {
    this.send = send;
    this.seen = new Set();
    // Первый проход читает ленту целиком — это история до нашего прихода.
    this.started = false;
  }

  /**
   * Автор строки.
   *
   * Две тонкости, обе видны в живом логе 15.09.2026:
   *
   * 1. Подряд идущие сообщения одного человека мессенджер группирует, и
   *    заголовок с именем стоит только на ПЕРВОЙ строке группы. Соседей
   *    перебирать мало — строки лежат в разных обёртках, поэтому идём по всему
   *    списку строк назад от нашей. Иначе второе сообщение приезжало от
   *    «участника» (так и было).
   * 2. В заголовке рядом с именем живёт роль («Администратор»), и innerText
   *    склеивает их в «Владимир К.Администратор». Роль отрезаем.
   */
  authorFor(node) {
    const row = node.closest('.yamb-message-row');
    if (!row) return 'участник';
    const rows = [...document.querySelectorAll('.yamb-message-row')];
    for (let i = rows.indexOf(row); i >= 0; i--) {
      const nameEl = rows[i].querySelector('.yamb-message-user__name');
      if (!nameEl) continue;
      const full = (nameEl.innerText || '').replace(/\s+/g, ' ').trim();
      const roleEl = rows[i].querySelector('.yamb-message-user__additional-text');
      const role = roleEl ? (roleEl.innerText || '').trim() : '';
      const name = role && full.endsWith(role) ? full.slice(0, full.length - role.length).trim() : full;
      if (name) return name;
    }
    return 'участник';
  }

  tick() {
    for (const span of document.querySelectorAll('.yamb-message-text span.text[id$="_c"]')) {
      const id = span.id.replace(/_c$/, '');
      if (this.seen.has(id)) continue;
      const text = (span.innerText || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      this.seen.add(id);
      // Первый проход — это история до нашего прихода: помечаем, чтобы
      // родитель не выдал её за новые сообщения встречи.
      this.send({ id, text, author: this.authorFor(span), historic: !this.started });
    }
    this.started = true;
  }

  /**
   * Что читатель видит в своём кадре.
   *
   * Нужен, потому что «кадр запустился» и «сообщения нашлись» — разные вещи,
   * а снаружи они выглядят одинаково: тишина. Раз в пять секунд, и только
   * пока сообщений нет вовсе, — как только чат заработает, замер замолкает.
   */
  report() {
    if (this.seen.size) return;
    this.send({
      debug: 'chat_frame_scan',
      строк: document.querySelectorAll('.yamb-message-row').length,
      текстов: document.querySelectorAll('.yamb-message-text').length,
      спанов: document.querySelectorAll('.yamb-message-text span.text[id$="_c"]').length,
      любыхСпанов: document.querySelectorAll('span.text').length,
      кадров: window.frames.length,
      теней: [...document.querySelectorAll('*')].filter((el) => el.shadowRoot).length,
      длинаТекста: (document.body.innerText || '').length,
      образец: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 120),
    });
  }

  start() {
    // Опрос, а не MutationObserver: мессенджер перерисовывает ленту целиком
    // при прокрутке, и наблюдатель давал бы шквал одинаковых событий. Раз в
    // полторы секунды хватает: чат на встрече — не поток.
    setInterval(() => {
      try { this.tick(); } catch (e) { console.error('[телемост] чат не прочитался', e); }
    }, 1500);
    setInterval(() => {
      try { this.report(); } catch (e) { console.error('[телемост] замер не снялся', e); }
    }, 5000);
  }
}

// ── Сборка ────────────────────────────────────────────────────────────────
//
// Целиком под try/catch: исключение здесь оставило бы `window.ws`
// неопределённым, и мост не смог бы ни принять звук, ни отдать его — со
// стороны это выглядит как «бот пришёл и молчит», без единой строки о причине.

// В кадре чата — только чтение и отправка родителю. Всё остальное (звук,
// состав, микрофон) живёт в кадре встречи, и заводить его копию в мессенджере
// значило бы поднять второй аудиограф и второй вебсокет впустую.
if (location.host === 'yandex.ru' && location.pathname.startsWith('/chat')) {
  try {
    const send = (msg) => window.parent.postMessage({ source: 'linkeon-telemost-chat', ...msg }, '*');
    new TelemostChatReader(send).start();
    // Сигнал в лог моста через родителя: иначе «кадр не запустился» и «в чате
    // пусто» выглядят одинаково. Ровно на этом мы потеряли заход 15.09.2026.
    send({ debug: 'chat_frame_ready', url: location.host + location.pathname });
    console.log('[телемост] чтение чата запущено');
  } catch (e) {
    console.error('[телемост] чтение чата не запустилось:', e);
  }
} else try {
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

  // Сообщения из кадра чата. Автора регистрируем участником со статусом
  // «не во встрече»: мост роняет сообщение, если участника нет в его списке
  // (upsert_chat_message → get_participant), а «в встрече» раздуло бы состав
  // и сломало правила выхода — join-события такой участник не порождает.
  const chatAuthors = new Map();
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.source !== 'linkeon-telemost-chat') return;
    if (d.debug) {
      const { source, debug, ...rest } = d;
      ws.sendJson({ type: 'TelemostDebug', event: debug, ...rest });
      return;
    }
    if (!d.text) return;
    // Историю до нашего прихода не пересылаем: это не обращения к ассистенту.
    if (d.historic) return;
    const author = String(d.author || 'участник');
    let uuid = chatAuthors.get(author);
    if (!uuid) {
      uuid = `telemost-chat-${chatAuthors.size + 1}`;
      chatAuthors.set(author, uuid);
      ws.sendJson({
        type: 'UsersUpdate',
        newUsers: [{
          deviceId: uuid, displayName: author, fullName: author, profile: '',
          status: 'not_in_meeting', humanized_status: 'not_in_meeting', isCurrentUser: false,
        }],
        removedUsers: [], updatedUsers: [],
      });
    }
    ws.sendJson({
      type: 'ChatMessage',
      message_uuid: String(d.id),
      participant_uuid: uuid,
      timestamp: Math.floor(Date.now() / 1000),
      text: String(d.text),
    });
    console.log('[телемост] чат:', author + ':', String(d.text).slice(0, 60));
  });

  console.log('[телемост] нагрузка страницы установлена');
} catch (e) {
  // До моста такое сообщение доедет только если ws успел подняться; если нет —
  // останется хотя бы в консоли страницы и на снимке экрана.
  console.error('[телемост] нагрузка НЕ установилась:', e);
  try {
    window.ws?.sendJson({ type: 'TelemostDebug', event: 'payload_failed', error: String(e && e.message || e) });
  } catch (_) { /* канала нет — ничего не поделать */ }
}
