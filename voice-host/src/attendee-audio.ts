import { voice, initializeLogger, loggerOptions } from '@livekit/agents';
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

/**
 * `voice.AudioOutput` читает глобальный логгер SDK прямо в конструкторе
 * (`this.logger = log()`), а инициализирует его обычно `cli.runApp()` при
 * старте процесса задания. В юнит-тестах машины сегментов такого старта нет,
 * и без страховки `new AttendeeAudioOutput(...)` падает с «logger not
 * initialized. did you forget to run initializeLogger()?» ещё до первого
 * captureFrame — это и уронило первый прогон.
 *
 * Проверка `loggerOptions()` — чтобы не перетереть логгер, который уже
 * настроил `cli.runApp()` внутри настоящего задания (уровень логирования,
 * pretty-print): наш файл там просто ничего не делает, вперёд неё.
 */
if (!loggerOptions()) initializeLogger({ pretty: false });

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
interface InboundAudio {
  trigger: 'realtime_audio.mixed';
  data: { chunk: string; sample_rate: number; timestamp_ms?: number };
}

/**
 * Один вебсокет-сервер на все встречи: `callId` приходит в query, по нему
 * находим, чьё это соединение. Отдельный порт на звонок означал бы дырявый
 * файрвол и гонку за портами между заданиями.
 */
export class AttendeeAudioHub {
  private readonly wss: WebSocketServer;
  private readonly waiting = new Map<string, (ws: WebSocket) => void>();

  constructor(port: number) {
    this.wss = new WebSocketServer({ port });
    this.wss.on('connection', (ws, req) => {
      const callId = new URL(req.url ?? '', 'http://x').searchParams.get('callId') ?? '';
      const claim = this.waiting.get(callId);
      if (!claim) {
        // Задание ещё не поднялось или уже завершилось. Закрываем, но с
        // записью в лог: Attendee будет ретраить, и молчание здесь означало
        // бы необъяснимо тихую встречу.
        console.log(`[attendee] соединение для неизвестного callId=${callId}`);
        ws.close();
        return;
      }
      this.waiting.delete(callId);
      console.log(`[attendee] звук подключился, callId=${callId}`);
      claim(ws);
    });
    console.log(`[attendee] жду звук на :${port}`);
  }

  /**
   * Занять место под звонок до того, как Attendee подключится.
   *
   * Возвращает `null` по таймауту — вызывающий обязан на это отреагировать,
   * а не ждать вечно.
   */
  expect(callId: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<WebSocket | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(callId);
        console.log(`[attendee] звук так и не подключился за ${timeoutMs / 1000}с, callId=${callId}`);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.waiting.set(callId, (ws) => { clearTimeout(timer); resolve(ws); });
    });
  }

  close(): void {
    this.wss.close();
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

  constructor(private readonly ws: WebSocket) {
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

    this.ws.on('message', (raw: any) => {
      let msg: InboundAudio;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.trigger !== 'realtime_audio.mixed' || !msg.data?.chunk) return;
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

  constructor(private readonly ws: WebSocket) {
    super(SAMPLE_RATE);
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    if (this.ws.readyState !== this.ws.OPEN) return;
    if (!this.segmentOpen) {
      this.segmentOpen = true;
      this.segment += 1;
      console.log(`[сегмент ${this.segment}] открыт`);
      this.onPlaybackStarted(Date.now());
    }
    const buf = Buffer.alloc(frame.data.length * 2);
    for (let i = 0; i < frame.data.length; i++) buf.writeInt16LE(frame.data[i], i * 2);
    this.ws.send(JSON.stringify({
      trigger: 'realtime_audio.bot_output',
      data: { chunk: buf.toString('base64'), sample_rate: SAMPLE_RATE },
    }));
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
