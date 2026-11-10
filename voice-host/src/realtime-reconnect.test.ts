import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeLogger } from '@livekit/agents';
import { realtime } from '@livekit/agents-plugin-openai';

/**
 * Переоткрытие сокета Realtime — на настоящем коде плагина, с подменённым
 * сокетом.
 *
 * Встреча 10.11.2026: на 20-й минуте сервер закрыл сокет без ошибки, плагин
 * пошёл открывать новый — и открытие не удалось. В SDK 1.7.0 открытие стоит
 * ВНЕ блока повторов: исключение выходит из цикла соединения, Task плагина
 * глотает его на уровне debug, и сессия до конца встречи живёт без модели.
 * Ни строки в логе, ни ошибки наверх — только «onInputSpeechStarted» и
 * тишина на 26 минут.
 */

initializeLogger({ pretty: false, level: 'fatal' });

const OPEN = 1;
const CLOSED = 3;

/** Ровно то, чем пользуется плагин у сокета ws. */
class FakeWs {
  readyState = OPEN;
  sent: any[] = [];
  onclose?: () => void;
  onerror?: (e: Error) => void;
  onmessage?: (m: { data: string }) => void;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.onclose?.();
  }
}

type Attempt = FakeWs | Error;

/**
 * Сессия плагина, у которой каждое открытие сокета берёт следующий исход из
 * списка. Подменяем прототип ДО создания: конструктор сразу запускает цикл.
 */
function sessionWith(attempts: Attempt[]) {
  const proto = realtime.RealtimeSession.prototype as any;
  const original = proto.createWsConn;
  const calls: number[] = [];
  proto.createWsConn = async function () {
    calls.push(Date.now());
    const next = attempts.shift();
    if (!next) return new Promise(() => {});
    if (next instanceof Error) throw next;
    return next;
  };
  const model = new realtime.RealtimeModel({ apiKey: 'test' });
  const session = model.session() as any;
  const errors: any[] = [];
  session.on('error', (e: any) => errors.push(e));
  // Подмена живёт до конца теста: переоткрытие тоже зовёт createWsConn.
  const restore = () => {
    proto.createWsConn = original;
  };
  return { session, calls, errors, restore };
}

async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
}

test('сервер закрыл сокет, новый не открылся — плагин пробует снова, а не глохнет молча', async () => {
  const first = new FakeWs();
  const third = new FakeWs();
  const { session, calls, restore } = sessionWith([first, new Error('OpenAI Realtime API connection closed'), third]);
  try {
    assert.ok(await until(() => calls.length === 1), 'первое соединение не открывалось');
    first.close();
    const reconnected = await until(() => calls.length === 3);
    assert.ok(reconnected, `открытий сокета: ${calls.length} — после неудачного открытия цикл соединения умер`);
    // Переоткрытие штатное: сессия заново описана новому сокету.
    assert.ok(await until(() => third.sent.some((e) => e.type === 'session.update')), 'новому сокету не отправлен session.update');
  } finally {
    await session.close();
    for (const ws of [first, third]) ws.close();
    restore();
  }
});

test('неудачное открытие видно наверху как восстановимая ошибка', async () => {
  // Без этого сбой переоткрытия не оставляет в логе ни строки.
  const first = new FakeWs();
  const third = new FakeWs();
  const { session, calls, errors, restore } = sessionWith([first, new Error('WebSocket connection timeout'), third]);
  try {
    await until(() => calls.length === 1);
    first.close();
    await until(() => calls.length === 3);
    assert.ok(errors.some((e) => e.recoverable === true), 'ошибка открытия не ушла наверх');
  } finally {
    await session.close();
    for (const ws of [first, third]) ws.close();
    restore();
  }
});
