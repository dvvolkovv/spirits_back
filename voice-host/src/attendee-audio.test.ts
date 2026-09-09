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

/**
 * Минимальная заглушка хаба: копит отправленное, слушателей не зовёт.
 *
 * Вывод держит ХАБ, а не сокет: сокет сменится при переподключении Attendee, и
 * знать об этом вывод не должен.
 */
function fakeHub(open = true) {
  const sent: any[] = [];
  return {
    send: (p: any) => { if (open) sent.push(p); return open; },
    onMessage: () => {},
    sent,
  } as any;
}

/** Дождаться условия, не завязываясь на конкретные задержки сети. */
async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('условие так и не наступило');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Кусок звука в том виде, в каком его присылает Attendee. */
function chunk(bytes = 960): string {
  return JSON.stringify({
    trigger: 'realtime_audio.mixed',
    data: { chunk: Buffer.alloc(bytes).toString('base64'), sample_rate: 24_000 },
  });
}

/** Кадр на 20 мс: 480 сэмплов при 24 кГц. */
const frame = () => new AudioFrame(new Int16Array(SAMPLES_PER_TICK), SAMPLE_RATE, 1, SAMPLES_PER_TICK);

describe('AttendeeAudioOutput', () => {
  test('кадр уходит в хаб правильным триггером и частотой', async () => {
    const hub = fakeHub();
    await new AttendeeAudioOutput(hub).captureFrame(frame());
    assert.equal(hub.sent.length, 1);
    assert.equal(hub.sent[0].trigger, 'realtime_audio.bot_output');
    assert.equal(hub.sent[0].data.sample_rate, 24_000);
    // 480 сэмплов PCM16 → 960 байт.
    assert.equal(Buffer.from(hub.sent[0].data.chunk, 'base64').length, 960);
  });

  test('позиция сегмента считается В СЕКУНДАХ', async () => {
    // Главная проверка этого файла. Миллисекунды OpenAI отбивал командой
    // обрезки («Audio content of 34350ms is already shorter than 10799999ms»),
    // сегмент зависал, и ассистент выпадал из встречи посреди фразы.
    const out = new AttendeeAudioOutput(fakeHub());
    let finished: any;
    (out as any).onPlaybackFinished = (e: any) => { finished = e; };
    for (let i = 0; i < 50; i++) await out.captureFrame(frame()); // 50 × 20 мс = 1 с
    out.flush();
    assert.ok(Math.abs(finished.playbackPosition - 1) < 1e-6,
      `ожидалась 1 секунда, получено ${finished.playbackPosition}`);
    assert.equal(finished.interrupted, false);
  });

  test('сегмент открывается ровно раз на серию кадров', async () => {
    const out = new AttendeeAudioOutput(fakeHub());
    let starts = 0;
    (out as any).onPlaybackStarted = () => { starts++; };
    await out.captureFrame(frame());
    await out.captureFrame(frame());
    assert.equal(starts, 1);
  });

  test('flush без кадров ничего не закрывает', () => {
    // Иначе сессия получила бы конец реплики, которой не было.
    const out = new AttendeeAudioOutput(fakeHub());
    let closed = 0;
    (out as any).onPlaybackFinished = () => { closed++; };
    out.flush();
    assert.equal(closed, 0);
  });

  test('второй flush поверх закрытого сегмента не повторяет событие', async () => {
    const out = new AttendeeAudioOutput(fakeHub());
    let closed = 0;
    (out as any).onPlaybackFinished = () => { closed++; };
    await out.captureFrame(frame());
    out.flush();
    out.flush();
    assert.equal(closed, 1);
  });

  test('перебивание закрывает сегмент как прерванный', async () => {
    // Без этого сессия ждала бы конца реплики, которой уже не будет.
    const out = new AttendeeAudioOutput(fakeHub());
    let finished: any;
    (out as any).onPlaybackFinished = (e: any) => { finished = e; };
    await out.captureFrame(frame());
    out.clearBuffer();
    assert.equal(finished.interrupted, true);
  });

  test('следующий сегмент начинает счёт с нуля', async () => {
    const out = new AttendeeAudioOutput(fakeHub());
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

  test('нет соединения — кадры в пустоту, но сегмент ведётся как обычно', async () => {
    // Пара onPlaybackStarted/onPlaybackFinished обязана сойтись даже когда
    // отправлять некуда: обрыв теперь не конец встречи, а ожидание возврата
    // бота. Если сегмент не закрыть, сессия будет ждать конца реплики,
    // которой уже не будет, и умолкнет навсегда — а бот к этому времени
    // вернётся, и молчание останется необъяснимым.
    const hub = fakeHub(false);
    const out = new AttendeeAudioOutput(hub);
    let starts = 0;
    let finished: any;
    (out as any).onPlaybackStarted = () => { starts++; };
    (out as any).onPlaybackFinished = (e: any) => { finished = e; };
    await out.captureFrame(frame());
    out.flush();
    assert.equal(hub.sent.length, 0, 'отправлять было некуда');
    assert.equal(starts, 1);
    assert.ok(finished, 'сегмент обязан закрыться');
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
      assert.equal(await waiting, false, 'чужое соединение не должно считаться нашим');
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
      assert.equal(await waiting, true, 'соединение должно быть принято');
      // Сокет наружу больше не отдаётся — им владеет хаб, и закрывает его
      // тоже он. Оба конца закрываем явно: wss.close() у 'ws' не трогает уже
      // установленные соединения, а незакрытый сокет держит event loop —
      // без --test-force-exit процесс этого тестового файла зависает
      // навсегда, а не просто не проходит тест. Поймано по факту 07.09.2026:
      // осиротевший процесс tsx висел на ноде CI до ручного kill.
    } finally {
      client?.terminate();
      hub.close();
    }
  });

  test('не дождались — false по таймауту', async () => {
    const hub = new AttendeeAudioHub();
    try {
      await hub.listen('c1');
      assert.equal(await hub.expect(300), false);
    } finally { hub.close(); }
  });

  test('звук идёт наружу через хаб, а не через сокет', async () => {
    const hub = new AttendeeAudioHub();
    let client: any;
    try {
      const port = await hub.listen('c1');
      const got: number[] = [];
      hub.onMessage((m) => got.push(Buffer.from(m.data.chunk, 'base64').length));
      const { WebSocket: Client } = await import('ws');
      client = new Client(`ws://127.0.0.1:${port}/?callId=c1`);
      client.on('error', () => {});
      await hub.expect(5_000);
      await new Promise((r) => client.on('open', r));
      client.send(chunk(960));
      client.send('{это не JSON');            // мусор не должен ронять приём
      client.send(JSON.stringify({ trigger: 'realtime_audio.bot_output' })); // чужой триггер
      client.send(chunk(480));
      await until(() => got.length === 2);
      assert.deepEqual(got, [960, 480]);
    } finally {
      client?.terminate();
      hub.close();
    }
  });

  test('ПЕРЕподключение принимается, и звук продолжает идти', async () => {
    // Главная проверка этого файла. 09.09.2026 на живой встрече вебсокет
    // оборвался на 95-й секунде, Attendee постучался снова — и получил
    // отказ, потому что хаб отдавал соединение ровно один раз. Встреча
    // оборвалась на середине разговора.
    const hub = new AttendeeAudioHub(60_000);
    let first: any;
    let second: any;
    try {
      const port = await hub.listen('c1');
      const got: number[] = [];
      hub.onMessage((m) => got.push(Buffer.from(m.data.chunk, 'base64').length));
      let lost = false;
      hub.onLost(() => { lost = true; });
      const { WebSocket: Client } = await import('ws');

      first = new Client(`ws://127.0.0.1:${port}/?callId=c1`);
      first.on('error', () => {});
      await hub.expect(5_000);
      await new Promise((r) => first.on('open', r));
      first.send(chunk(960));
      await until(() => got.length === 1);

      first.close();
      second = new Client(`ws://127.0.0.1:${port}/?callId=c1`);
      second.on('error', () => {});
      await new Promise((r) => second.on('open', r));
      second.send(chunk(480));
      await until(() => got.length === 2);
      assert.deepEqual(got, [960, 480], 'звук после переподключения не дошёл');
      assert.equal(lost, false, 'вернувшийся бот не повод считать звук потерянным');
      assert.equal(hub.send({ trigger: 'realtime_audio.bot_output' }), true,
        'вывод обязан писать в новое соединение');
    } finally {
      first?.terminate();
      second?.terminate();
      hub.close();
    }
  });

  test('не вернулся за отведённое время — звук потерян', async () => {
    const hub = new AttendeeAudioHub(80);
    let client: any;
    try {
      const port = await hub.listen('c1');
      let lost = 0;
      hub.onLost(() => { lost++; });
      const { WebSocket: Client } = await import('ws');
      client = new Client(`ws://127.0.0.1:${port}/?callId=c1`);
      client.on('error', () => {});
      await hub.expect(5_000);
      // Пока окно не вышло — звук ещё не потерян, и сессию закрывать рано.
      client.close();
      await until(() => hub.send({ x: 1 }) === false);
      assert.equal(lost, 0, 'потеря объявлена, не дождавшись возврата');
      await until(() => lost === 1);
      assert.equal(lost, 1);
    } finally {
      client?.terminate();
      hub.close();
    }
  });

  test('уже потерянный звук отдаётся сразу при подписке', async () => {
    // Обрыв может случиться в окне между ожиданием звука и стартом сессии, а
    // подписаться раньше нельзя — закрывать ещё нечего. Без этого встреча
    // висела бы до двухчасового потолка, тикая тишиной.
    const hub = new AttendeeAudioHub(50);
    let client: any;
    try {
      const port = await hub.listen('c1');
      const { WebSocket: Client } = await import('ws');
      client = new Client(`ws://127.0.0.1:${port}/?callId=c1`);
      client.on('error', () => {});
      await hub.expect(5_000);
      client.close();
      await new Promise((r) => setTimeout(r, 200));
      let lost = false;
      hub.onLost(() => { lost = true; });
      assert.equal(lost, true);
    } finally {
      client?.terminate();
      hub.close();
    }
  });
});
