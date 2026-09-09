import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AudioFrame } from '@livekit/rtc-node';
import { initializeLogger, loggerOptions } from '@livekit/agents';
import { AttendeeAudioHub, AttendeeAudioOutput, SAMPLE_RATE, SAMPLES_PER_TICK } from './attendee-audio.js';

/**
 * Логгер SDK — установка теста, а не продового кода.
 *
 * `voice.AudioOutput` читает глобальный логгер прямо в конструкторе
 * (`this.logger = log()`), а инициализирует его `cli.runApp()` при старте
 * задания. В юнит-тестах такого старта нет, и `new AttendeeAudioOutput(...)`
 * падал бы с «logger not initialized» ещё до первого captureFrame.
 *
 * Здесь, а не в attendee-audio.ts: побочный эффект на уровне продового модуля
 * существовал бы только ради тестов. Сейчас `initializeLogger` перетирает
 * настройки безусловно, то есть `cli.runApp()` в проде их перекрыл бы — но
 * защити библиотека однажды повторный вызов, и прод молча получил бы
 * тестовые настройки логирования.
 */
if (!loggerOptions()) initializeLogger({ pretty: false });

/** Минимальная заглушка ws: копит отправленное, слушателей не зовёт. */
function fakeWs() {
  const sent: any[] = [];
  return {
    OPEN: 1, readyState: 1,
    send: (s: string) => sent.push(JSON.parse(s)),
    on: () => {},
    sent,
  } as any;
}

/** Кадр на 20 мс: 480 сэмплов при 24 кГц. */
const frame = () => new AudioFrame(new Int16Array(SAMPLES_PER_TICK), SAMPLE_RATE, 1, SAMPLES_PER_TICK);

describe('AttendeeAudioOutput', () => {
  test('кадр уходит в ws правильным триггером и частотой', async () => {
    const ws = fakeWs();
    await new AttendeeAudioOutput(ws).captureFrame(frame());
    assert.equal(ws.sent.length, 1);
    assert.equal(ws.sent[0].trigger, 'realtime_audio.bot_output');
    assert.equal(ws.sent[0].data.sample_rate, 24_000);
    // 480 сэмплов PCM16 → 960 байт.
    assert.equal(Buffer.from(ws.sent[0].data.chunk, 'base64').length, 960);
  });

  test('позиция сегмента считается В СЕКУНДАХ', async () => {
    // Главная проверка этого файла. Миллисекунды OpenAI отбивал командой
    // обрезки («Audio content of 34350ms is already shorter than 10799999ms»),
    // сегмент зависал, и ассистент выпадал из встречи посреди фразы.
    const ws = fakeWs();
    const out = new AttendeeAudioOutput(ws);
    let finished: any;
    (out as any).onPlaybackFinished = (e: any) => { finished = e; };
    for (let i = 0; i < 50; i++) await out.captureFrame(frame()); // 50 × 20 мс = 1 с
    out.flush();
    assert.ok(Math.abs(finished.playbackPosition - 1) < 1e-6,
      `ожидалась 1 секунда, получено ${finished.playbackPosition}`);
    assert.equal(finished.interrupted, false);
  });

  test('сегмент открывается ровно раз на серию кадров', async () => {
    const ws = fakeWs();
    const out = new AttendeeAudioOutput(ws);
    let starts = 0;
    (out as any).onPlaybackStarted = () => { starts++; };
    await out.captureFrame(frame());
    await out.captureFrame(frame());
    assert.equal(starts, 1);
  });

  test('flush без кадров ничего не закрывает', () => {
    // Иначе сессия получила бы конец реплики, которой не было.
    const out = new AttendeeAudioOutput(fakeWs());
    let closed = 0;
    (out as any).onPlaybackFinished = () => { closed++; };
    out.flush();
    assert.equal(closed, 0);
  });

  test('второй flush поверх закрытого сегмента не повторяет событие', async () => {
    const out = new AttendeeAudioOutput(fakeWs());
    let closed = 0;
    (out as any).onPlaybackFinished = () => { closed++; };
    await out.captureFrame(frame());
    out.flush();
    out.flush();
    assert.equal(closed, 1);
  });

  test('перебивание закрывает сегмент как прерванный', async () => {
    // Без этого сессия ждала бы конца реплики, которой уже не будет.
    const out = new AttendeeAudioOutput(fakeWs());
    let finished: any;
    (out as any).onPlaybackFinished = (e: any) => { finished = e; };
    await out.captureFrame(frame());
    out.clearBuffer();
    assert.equal(finished.interrupted, true);
  });

  test('следующий сегмент начинает счёт с нуля', async () => {
    const out = new AttendeeAudioOutput(fakeWs());
    const positions: number[] = [];
    (out as any).onPlaybackFinished = (e: any) => { positions.push(e.playbackPosition); };
    await out.captureFrame(frame());
    out.flush();
    await out.captureFrame(frame());
    await out.captureFrame(frame());
    out.flush();
    assert.equal(positions.length, 2);
    assert.ok(positions[1] > positions[0], 'счётчик не обнулился между сегментами');
  });

  test('закрытый ws кадры не роняют', async () => {
    const ws = fakeWs();
    ws.readyState = 3; // CLOSED
    const out = new AttendeeAudioOutput(ws);
    await out.captureFrame(frame());
    assert.equal(ws.sent.length, 0);
  });
});

describe('AttendeeAudioHub', () => {
  test('занимает порт из диапазона и отдаёт публичный URL с ним', async () => {
    const hub = new AttendeeAudioHub();
    try {
      const port = await hub.listen('c1');
      // Диапазон по умолчанию — один порт: он же потолок одновременных
      // встреч Meet (см. комментарий у PORT_MIN/PORT_MAX в attendee-audio.ts).
      assert.equal(port, 8140, `порт вне диапазона: ${port}`);
      const url = hub.publicUrl('c1');
      // Порт в пути, а не в host:port — TLS терминирует nginx.
      assert.match(url, new RegExp(`/attendee/${port}\\?callId=c1$`));
    } finally { hub.close(); }
  });

  test('порт уезжает в путь: Attendee требует wss и nginx терминирует TLS', async () => {
    // Открытый ws Attendee отвергает валидатором («URL must start with
    // wss://»), проверено на живом сервисе. Значит форма адреса одна.
    const hub = new AttendeeAudioHub();
    const saved = process.env.ATTENDEE_WS_PUBLIC_BASE;
    try {
      const port = await hub.listen('c1');
      process.env.ATTENDEE_WS_PUBLIC_BASE = 'wss://test.linkeon.io';
      assert.equal(hub.publicUrl('c1'), `wss://test.linkeon.io/attendee/${port}?callId=c1`);
    } finally {
      hub.close();
      if (saved === undefined) delete process.env.ATTENDEE_WS_PUBLIC_BASE;
      else process.env.ATTENDEE_WS_PUBLIC_BASE = saved;
    }
  });

  test('второй хаб на ту же встречу честно отказывает, а не падает молча', async () => {
    // Потолок в одну одновременную встречу держится ровно этим: диапазон
    // сужен до одного порта, и второму хабу занять нечего. При потолке в
    // одну встречу это НОРМА для второго пользователя, а не редкость — и
    // ошибка обязана быть внятной, а не EADDRINUSE без объяснения или,
    // того хуже, повисшим промисом.
    const a = new AttendeeAudioHub();
    const b = new AttendeeAudioHub();
    try {
      await a.listen('c1');
      await assert.rejects(
        () => b.listen('c2'),
        (e: any) => {
          assert.match(e.message, /занят|нет свободного порта/, `ошибка не внятная: ${e.message}`);
          return true;
        },
      );
    } finally { a.close(); b.close(); }
  });

  test('соединение с чужим callId отвергается', async () => {
    const hub = new AttendeeAudioHub();
    try {
      const port = await hub.listen('c1');
      const waiting = hub.expect(1_000);
      const { WebSocket: Client } = await import('ws');
      const bad = new Client(`ws://127.0.0.1:${port}/?callId=ЧУЖОЙ`);
      await new Promise((r) => bad.on('close', r));
      assert.equal(await waiting, null, 'чужое соединение не должно считаться нашим');
    } finally { hub.close(); }
  });

  test('своё соединение дождались', async () => {
    const hub = new AttendeeAudioHub();
    let client: any;
    try {
      const port = await hub.listen('c1');
      const waiting = hub.expect(5_000);
      const { WebSocket: Client } = await import('ws');
      client = new Client(`ws://127.0.0.1:${port}/?callId=c1`);
      // Слушатель обязателен: 'connection' на сервере иногда обгоняет 'open'
      // на клиенте, и terminate() ниже в такой момент кидает «closed before
      // the connection was established». Без слушателя это всплывает
      // необработанным исключением уже ПОСЛЕ конца теста, а не просто
      // фейлит его.
      client.on('error', () => {});
      const ws = await waiting;
      assert.ok(ws, 'соединение должно быть получено');
      // Оба конца закрываем явно: wss.close() у 'ws' не трогает уже
      // установленные соединения, а незакрытый сокет держит event loop —
      // без --test-force-exit процесс этого тестового файла зависает
      // навсегда, а не просто не проходит тест. Поймано по факту 07.09.2026:
      // осиротевший процесс tsx висел на ноде CI до ручного kill.
      ws?.terminate();
    } finally {
      client?.terminate();
      hub.close();
    }
  });

  test('не дождались — null по таймауту', async () => {
    const hub = new AttendeeAudioHub();
    try {
      await hub.listen('c1');
      assert.equal(await hub.expect(300), null);
    } finally { hub.close(); }
  });
});
