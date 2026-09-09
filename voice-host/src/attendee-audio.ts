import { voice } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { WebSocketServer, type WebSocket } from 'ws';
import { Mixer, TICK_MS } from './mixer.js';

/**
 * Звук встречи на площадке без LiveKit — через вебсокет Attendee.
 *
 * Пара к mixed-audio-input.ts и external-room-output.ts: те же два конца
 * сессии, но снаружи не вторая комната LiveKit, а вебсокет. Attendee
 * подключается К НАМ (и ретраит до 30 раз с интервалом 2 с), поэтому здесь
 * сервер, а не клиент.
 *
 * Частота 24 кГц на всём пути: родная для OpenAI Realtime, ресемплинга нет
 * нигде — ни у нас, ни в Attendee.
 */


export const SAMPLE_RATE = 24_000;
export const SAMPLES_PER_TICK = (SAMPLE_RATE * TICK_MS) / 1000; // 480

/**
 * Сколько ждём подключения Attendee.
 *
 * Ретраи у него — до 30 раз по 2 секунды, плюс сам бот поднимает Chrome и
 * грузит страницу Meet (заявлено до 30 секунд). Две минуты покрывают это с
 * запасом. Ждать бесконечно нельзя: задание повиснет, фреймворк убьёт его как
 * «unresponsive», и звонок останется в базе активным — то есть запрёт
 * пользователю следующий вход.
 */
export const CONNECT_TIMEOUT_MS = 120_000;

/** Что Attendee присылает нам. */
export interface InboundAudio {
  trigger: 'realtime_audio.mixed';
  data: { chunk: string; sample_rate: number; timestamp_ms?: number };
}

/**
 * Сколько ждём переподключения, прежде чем признать звук потерянным.
 *
 * Обрыв посреди встречи — не повод её заканчивать: Attendee ретраит до 30 раз
 * с интервалом 2 с и обычно возвращается за секунды. Проверено вживую
 * 09.09.2026 на встрече с владельцем: вебсокет оборвался на 95-й секунде,
 * прежняя редакция сразу закрыла сессию — и оборвала живой разговор, хотя
 * Attendee постучался снова через мгновение. Постучался и получил отказ
 * («[attendee] соединение не для нас» в логе воркера): хаб отдавал соединение
 * наружу ровно один раз и второе принять не мог.
 *
 * Полторы минуты покрывают его ретраи с запасом.
 */
export const RECONNECT_GRACE_MS = 90_000;

/**
 * Как часто пингуем Attendee.
 *
 * Причина того обрыва на 95-й секунде не установлена, и пинг здесь —
 * страховка от посредника, закрывающего соединение по бездействию: звук ОТ
 * Attendee идёт непрерывно, а наш конец молчит, пока ассистент не говорит, —
 * а таймауты по бездействию обычно считают именно свою сторону.
 */
export const PING_INTERVAL_MS = 30_000;

/**
 * Диапазон портов под приём звука. По умолчанию — ОДИН порт.
 *
 * Это и есть потолок одновременных встреч Meet, и он не произволен: в
 * Celery-режиме Attendee несколько ботов в одном контейнере делят
 * аудиоустройства, и звук разных встреч может перетекать. При одном боте
 * перетекать нечему. Изоляция по поду требует Kubernetes, инструкции к
 * которому у Attendee в платном плане — решение владельца 07.09.2026.
 *
 * Расширять диапазон можно только вместе с переходом на изоляцию ботов,
 * иначе потолок снимется, а утечка звука между переговорами клиентов
 * появится. Диапазон обязан совпадать с регуляркой в
 * infra/attendee/nginx-attendee.conf.
 */
const PORT_MIN = Number(process.env.ATTENDEE_WS_PORT_MIN || 8140);
const PORT_MAX = Number(process.env.ATTENDEE_WS_PORT_MAX || 8140);

/**
 * Приём звука для ОДНОГО задания.
 *
 * Один хаб на задание, а не на процесс. Прежняя схема с общим портом на
 * уровне модуля была неработоспособна: каждое задание в @livekit/agents —
 * отдельный процесс, который импортирует модуль сразу при старте, ещё не
 * зная, достанется ли ему встреча. Пул греет замену в момент, когда задание
 * забирает прогретый процесс, и замена падала с EADDRINUSE.
 *
 * Отсюда и порядок: порт узнаёт тот, кто им владеет, и сообщает бэкенду, а
 * бот создаётся уже после этого.
 *
 * Хаб — ВЛАДЕЛЕЦ сокета, а не выдаватель. Вход и выход сессии работают через
 * него и о переподключении не знают. Прежняя редакция отдавала сокет наружу
 * один раз, и обрыв означал конец встречи (см. RECONNECT_GRACE_MS).
 */
export class AttendeeAudioHub {
  private wss?: WebSocketServer;
  private port = 0;
  private callId = '';
  /** Текущее соединение. `null` — обрыв, ждём переподключения. */
  private ws: WebSocket | null = null;
  private onMsg: ((msg: InboundAudio) => void) | null = null;
  private firstClaim: ((connected: boolean) => void) | null = null;
  private onLostCb: (() => void) | null = null;
  private grace?: ReturnType<typeof setTimeout>;
  private pinger?: ReturnType<typeof setInterval>;
  private lost = false;
  private closed = false;
  private reconnects = 0;

  /**
   * Окно ожидания возврата бота. Параметр — ради тестов: полторы минуты в
   * юнит-тесте не подождёшь, а проверять переподключение обязательно нужно
   * именно тестом. В проде значение одно и по умолчанию.
   */
  constructor(private readonly graceMs = RECONNECT_GRACE_MS) {}

  /**
   * Занять первый свободный порт диапазона.
   *
   * Перебором, а не портом 0: сообщить бэкенду публичный URL можно только
   * зная конкретный порт, а он обязан попадать в открытый на файрволе
   * диапазон.
   */
  async listen(callId: string): Promise<number> {
    this.callId = callId;
    for (let p = PORT_MIN; p <= PORT_MAX; p++) {
      try {
        this.wss = await this.bind(p);
        this.port = p;
        break;
      } catch (e: any) {
        if (e?.code !== 'EADDRINUSE') throw e;
      }
    }
    if (!this.wss) {
      // При потолке в одну встречу (PORT_MIN === PORT_MAX) это НОРМА, а не
      // редкость: второй одновременный вход в Meet должен получить внятный
      // отказ через ошибку, а не молча повиснуть или упасть в непонятном
      // месте. Формулировка отдельная для одного порта и для диапазона —
      // «8140-8140» читается странно.
      const reason = PORT_MIN === PORT_MAX
        ? `порт ${PORT_MIN} занят — Meet уже держит одну встречу`
        : `нет свободного порта в диапазоне ${PORT_MIN}-${PORT_MAX}`;
      throw new Error(reason);
    }

    // Ошибку сервера обязательно слушаем: событие 'error' без слушателя в
    // Node бросается синхронно там, где эмитится, и роняет весь процесс
    // задания — посреди живой встречи, без complete и без failed.
    this.wss.on('error', (e) => console.error('[attendee] ошибка сервера', e));
    this.wss.on('connection', (ws, req) => this.adopt(ws, req.url ?? ''));

    // Держим соединение живым. Интервал — с unref по тем же причинам, что и
    // тикер входа: иначе задание не завершится и фреймворк убьёт его как
    // «unresponsive» вместе с недоотправленным complete.
    this.pinger = setInterval(() => {
      if (this.ws && this.ws.readyState === this.ws.OPEN) {
        try { this.ws.ping(); } catch { /* сокет умирает — 'close' разберётся */ }
      }
    }, PING_INTERVAL_MS);
    this.pinger.unref?.();

    console.log(`[attendee] жду звук на :${this.port}, callId=${callId}`);
    return this.port;
  }

  /**
   * Принять соединение — первое или пришедшее на замену оборванному.
   *
   * Переподключение отсюда наружу не видно вовсе: наружу выходит только
   * onLost(), то есть случай «бот так и не вернулся».
   */
  private adopt(ws: WebSocket, url: string): void {
    const got = new URL(url, 'http://x').searchParams.get('callId') ?? '';
    if (this.closed || this.lost || got !== this.callId) {
      console.log(`[attendee] соединение не для нас: callId=${got}`);
      ws.close();
      return;
    }
    // Тот же довод, что и для сервера: без слушателя сетевой сбой на этом
    // сокете уронит процесс.
    ws.on('error', (e) => console.error('[attendee] ошибка сокета', e));

    const again = this.ws !== null || this.grace !== undefined;
    if (this.grace) {
      clearTimeout(this.grace);
      this.grace = undefined;
    }
    // Прежний сокет закрываем сами: Attendee мог открыть новый, не закрыв
    // старый, и тогда звук шёл бы к нам в два потока — микшер сложил бы
    // встречу саму с собой.
    if (this.ws && this.ws !== ws) {
      try { this.ws.close(); } catch { /* уже мёртв */ }
    }
    this.ws = ws;
    if (again) this.reconnects++;

    ws.on('message', (raw: any) => {
      if (!this.onMsg) return;
      let msg: InboundAudio;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.trigger !== 'realtime_audio.mixed' || !msg.data?.chunk) return;
      this.onMsg(msg);
    });

    ws.on('close', () => {
      if (this.ws !== ws) return;   // закрылся уже заменённый сокет
      this.ws = null;
      if (this.closed) return;
      console.log(`[attendee] звук оборвался, ждём возврата до ${this.graceMs / 1000}с`);
      this.grace = setTimeout(() => {
        this.grace = undefined;
        this.lost = true;
        console.log('[attendee] бот не вернулся — звук потерян');
        this.onLostCb?.();
      }, this.graceMs);
      this.grace.unref?.();
    });

    console.log(
      `[attendee] звук ${again ? `ПЕРЕподключился (${this.reconnects})` : 'подключился'}` +
      `, callId=${this.callId}, порт ${this.port}`,
    );
    const claim = this.firstClaim;
    this.firstClaim = null;
    claim?.(true);
  }

  private bind(port: number): Promise<WebSocketServer> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port });
      const onError = (e: any) => { wss.close(); reject(e); };
      wss.once('error', onError);
      wss.once('listening', () => { wss.off('error', onError); resolve(wss); });
    });
  }

  /**
   * Адрес, по которому Attendee придёт за звуком.
   *
   * Порт уезжает в ПУТЬ: `wss://host/attendee/8140`. Соответствующий location
   * с диапазоном портов в регулярке — в infra/attendee/nginx-attendee.conf.
   *
   * TLS здесь не удобство, а условие работы: **Attendee требует `wss://` и
   * проверяет это валидатором.** Проверено на живом сервисе 09.09.2026 —
   * попытка отдать `ws://` отвергается с
   * `websocket_settings.audio.url: URL must start with wss://`. То же для
   * вебхуков: `does not match '^https://.*'`.
   *
   * Поэтому «прямого» режима с портом в адресе и открытым ws здесь нет: он
   * был добавлен на неверном предположении, что на одной машине можно
   * обойтись без nginx, и удалён, когда Attendee его отверг.
   */
  publicUrl(callId: string): string {
    const base = (process.env.ATTENDEE_WS_PUBLIC_BASE || 'wss://my.linkeon.io').replace(/\/+$/, '');
    return `${base}/attendee/${this.port}?callId=${encodeURIComponent(callId)}`;
  }

  /**
   * Дождаться ПЕРВОГО подключения. `false` — не дождались за отведённое время.
   *
   * Дальше ждать нечего: обрывы и переподключения хаб переживает сам, и
   * наружу выходит только onLost().
   */
  expect(timeoutMs = CONNECT_TIMEOUT_MS): Promise<boolean> {
    if (this.ws) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.firstClaim = null;
        console.log(`[attendee] звук так и не подключился за ${timeoutMs / 1000}с`);
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      this.firstClaim = (connected) => { clearTimeout(timer); resolve(connected); };
    });
  }

  /**
   * Звук потерян окончательно: оборвался и переподключения не случилось.
   *
   * Если это уже произошло до подписки — зовём сразу. Иначе сигнал терялся бы
   * в окне между обрывом и стартом сессии, а встреча висела бы до
   * двухчасового потолка, тикая тишиной.
   */
  onLost(cb: () => void): void {
    this.onLostCb = cb;
    if (this.lost) cb();
  }

  /** Подписка входа сессии на куски звука. Слушатель один — последний. */
  onMessage(cb: (msg: InboundAudio) => void): void {
    this.onMsg = cb;
  }

  /**
   * Отправить кадр в текущее соединение.
   *
   * `false` — соединения нет (обрыв, ждём возврата). Кадр в этом случае
   * роняется: очередь копить бессмысленно, к возвращению бота реплика уже
   * потеряет смысл, а сессия ждёт от вывода потока в реальном времени.
   */
  send(payload: unknown): boolean {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return false;
    this.ws.send(JSON.stringify(payload));
    return true;
  }

  close(): void {
    this.closed = true;
    if (this.grace) clearTimeout(this.grace);
    if (this.pinger) clearInterval(this.pinger);
    try { this.ws?.close(); } catch {}
    try { this.wss?.close(); } catch {}
    this.ws = null;
    this.wss = undefined;
  }
}

/**
 * Вход сессии из вебсокета.
 *
 * Микширование не нужно — Attendee отдаёт готовый микс. Нужен РИТМ: Realtime
 * ждёт ровный кадр каждые 20 мс, а куски по сети приходят вразнобой и разной
 * длины. Mixer именно это и делает — буфер с потолком полсекунды и добивка
 * тишиной; с одним участником сумма вырождается в проброс.
 */
export class AttendeeAudioInput extends voice.AudioInput {
  private mixer = new Mixer(SAMPLES_PER_TICK);
  private ticker?: ReturnType<typeof setInterval>;
  private closed = false;
  private push: (f: AudioFrame) => void = () => {};
  private framesIn = 0;
  private ticks = 0;

  constructor(private readonly hub: AttendeeAudioHub) {
    super();

    const source = new ReadableStream<AudioFrame>({
      start: (controller) => {
        this.push = (f) => {
          if (this.closed) return;
          try { controller.enqueue(f); } catch { /* поток закрыт раньше тика */ }
        };
      },
    });
    this.multiStream.addInputStream(source);

    // Через хаб, а не через сокет: сокет меняется при переподключении, и
    // вход не должен об этом знать.
    this.hub.onMessage((msg) => {
      if (this.closed) return;
      const buf = Buffer.from(msg.data.chunk, 'base64');
      // PCM16 little-endian. Копируем в свой буфер: Int16Array поверх чужого
      // Buffer живёт ровно до следующего сообщения ws.
      const pcm = new Int16Array(buf.byteLength >> 1);
      for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(i * 2);
      this.framesIn++;
      this.mixer.push('meet', pcm);
    });

    this.ticker = setInterval(() => {
      if (this.closed) return;
      this.push(new AudioFrame(this.mixer.tick(), SAMPLE_RATE, 1, SAMPLES_PER_TICK));
      // Без этой строки «никто не говорит» и «звук до нас не доходит»
      // выглядят одинаково — тишиной. На своих комнатах я гадал здесь трижды.
      if (++this.ticks % 250 === 0) {
        console.log(`[вход] тиков: ${this.ticks}, кусков от Attendee: ${this.framesIn}`);
      }
    }, TICK_MS);
    // unref обязателен: иначе таймер держит event loop, задание не
    // завершается, и фреймворк убивает его как «unresponsive» вместе с
    // недоотправленным complete. Так дважды терялся транскрипт.
    this.ticker.unref?.();
  }

  override async close(): Promise<void> {
    this.closed = true;
    if (this.ticker) clearInterval(this.ticker);
    await super.close();
  }
}

/**
 * Голос ассистента — в вебсокет.
 *
 * Зеркало ExternalRoomAudioOutput, вместе с двумя вещами, которые там стоили
 * живых встреч: сегменты открываются первым кадром и закрываются явно, а
 * `playbackPosition` считается В СЕКУНДАХ. Миллисекунды OpenAI отбивал
 * («Audio content of 34350ms is already shorter than 10799999ms»), сегмент
 * зависал, и ассистент выпадал из встречи посреди фразы.
 *
 * Отличие одно: ждать доигрывания нечего — очередь держит уже не наш
 * AudioSource, а Attendee. Позицию сообщаем сразу по flush.
 */
export class AttendeeAudioOutput extends voice.AudioOutput {
  private segmentOpen = false;
  private segment = 0;
  private pushedSec = 0;
  private interrupted = false;
  private frames = 0;
  private dropped = 0;

  constructor(private readonly hub: AttendeeAudioHub) {
    super(SAMPLE_RATE);
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    if (!this.segmentOpen) {
      this.segmentOpen = true;
      this.segment += 1;
      console.log(`[сегмент ${this.segment}] открыт`);
      this.onPlaybackStarted(Date.now());
    }
    const buf = Buffer.alloc(frame.data.length * 2);
    for (let i = 0; i < frame.data.length; i++) buf.writeInt16LE(frame.data[i], i * 2);
    // Соединения может не быть — обрыв, ждём возврата бота. Кадр тогда
    // роняем, но сегмент ведём как обычно: пара onPlaybackStarted /
    // onPlaybackFinished обязана сойтись, иначе сессия будет ждать конца
    // реплики, которой уже не будет, и умолкнет навсегда.
    const sent = this.hub.send({
      trigger: 'realtime_audio.bot_output',
      data: { chunk: buf.toString('base64'), sample_rate: SAMPLE_RATE },
    });
    if (!sent && ++this.dropped % 250 === 0) {
      console.log(`[выход] кадров в пустоту: ${this.dropped} — звука нет`);
    }
    this.pushedSec += frame.samplesPerChannel / SAMPLE_RATE;
    if (++this.frames % 250 === 0) console.log(`[выход] кадров ассистента: ${this.frames}`);
  }

  flush(): void {
    super.flush();
    if (!this.segmentOpen) return;
    this.finishSegment(this.interrupted);
  }

  private finishSegment(interrupted: boolean): void {
    if (!this.segmentOpen) return;
    const position = this.pushedSec;
    console.log(`[сегмент ${this.segment}] закрыт: ${position.toFixed(1)}с${interrupted ? ', прерван' : ''}`);
    this.segmentOpen = false;
    this.pushedSec = 0;
    this.interrupted = false;
    // В СЕКУНДАХ. См. комментарий в шапке класса.
    this.onPlaybackFinished({ playbackPosition: position, interrupted });
  }

  /**
   * Ассистента перебили.
   *
   * Своей очереди у нас нет, поэтому гасить нечего — но сегмент закрыть
   * обязаны, иначе сессия ждёт конца реплики, которой уже не будет.
   *
   * ВНИМАНИЕ, известное ограничение: недосказанное всё ещё лежит в буфере
   * Attendee и договорится поверх нового собеседника. Есть ли у Attendee
   * команда сброса очереди — вопрос 7 спайка; если нет, перебивание в Meet
   * будет слышно хуже, чем в своих комнатах.
   */
  clearBuffer(): void {
    this.interrupted = true;
    if (this.segmentOpen) this.finishSegment(true);
  }
}
