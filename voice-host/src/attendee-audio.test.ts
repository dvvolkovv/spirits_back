import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AudioFrame } from '@livekit/rtc-node';
import { initializeLogger, loggerOptions } from '@livekit/agents';
import { AttendeeAudioOutput, SAMPLE_RATE, SAMPLES_PER_TICK } from './attendee-audio.js';

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
