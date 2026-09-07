import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ExternalRoomChat } from './external-chat.js';

const URL = 'https://api.talerid.io/voice/rooms/personal-c79530ed-36fc367a/chat';
const NAME = 'Роман · ассистент Дмитрий';

/** Ответ их ручки, снятый живьём 07.09.2026. */
const created = () => ({ ok: true, status: 201, json: async () => ({ ts: 1788768370404 }) });

const pack = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));

/** Настоящий пакет из их комнаты, снятый живьём 07.09.2026. */
const incoming = (over: Record<string, unknown> = {}) =>
  pack({
    type: 'chat_message',
    text: 'Вот документ: https://linkeon.io/doc/42',
    name: 'Дмитрий Волков',
    ts: 1788768440123,
    msgId: 'server_f46cf041-b5da-4bb3-918a-af832a2d4255',
    ...over,
  });

describe('send', () => {
  test('шлёт текст с Bearer и своим именем', async () => {
    const calls: any[] = [];
    const chat = new ExternalRoomChat(URL, 'jwt.body.sig', NAME, async (u: any, i: any) => {
      calls.push([String(u), i]);
      return created() as any;
    });

    assert.equal(await chat.send('Документ готов'), true);
    assert.equal(calls.length, 1);
    const [url, init] = calls[0];
    assert.equal(url, URL);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer jwt.body.sig');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(init.body), { text: 'Документ готов', name: NAME });
    // Тул исполняется синхронно и держит разговор: без таймаута зависшая
    // ручка молчала бы всю встречу на undici-дефолте в 300 секунд.
    assert.ok(init.signal, 'таймаут отправки не выставлен');
  });

  test('пустой текст никуда не шлёт', async () => {
    let called = 0;
    const chat = new ExternalRoomChat(URL, 't', NAME, async () => { called++; return created() as any; });
    assert.equal(await chat.send('   '), false);
    assert.equal(called, 0);
  });

  test('403 не исключение, а false', async () => {
    // Их ручка отвечает 403 «No access to this room» на чужую комнату и 401
    // без токена. Тул модели должен получить внятный отказ, а не падение.
    const chat = new ExternalRoomChat(URL, 't', NAME, async () =>
      ({ ok: false, status: 403, text: async () => 'No access to this room' }) as any);
    assert.equal(await chat.send('привет'), false);
  });

  test('упавшая сеть тоже false', async () => {
    const chat = new ExternalRoomChat(URL, 't', NAME, async () => { throw new Error('ECONNREFUSED'); });
    assert.equal(await chat.send('привет'), false);
  });
});

describe('parse', () => {
  const chat = () => new ExternalRoomChat(URL, 't', NAME, async () => created() as any);

  test('разбирает настоящий пакет их комнаты', () => {
    assert.deepEqual(chat().parse(incoming()), {
      text: 'Вот документ: https://linkeon.io/doc/42',
      name: 'Дмитрий Волков',
      ts: 1788768440123,
    });
  });

  test('своё эхо отбрасывает по имени', () => {
    // Отбрасывать по ts из ответа POST нельзя: эхо приходит РАНЬШЕ, чем
    // резолвится промис отправки (снято живьём 07.09.2026). К этому моменту
    // никакого ts у нас ещё нет, зато имя своё.
    assert.equal(chat().parse(incoming({ name: NAME })), null);
  });

  test('имя сравнивается без учёта регистра и лишних пробелов', () => {
    assert.equal(chat().parse(incoming({ name: `  ${NAME.toUpperCase()} ` })), null);
  });

  test('чужой тип пакета — не чат', () => {
    assert.equal(chat().parse(pack({ type: 'reaction', name: 'Дмитрий' })), null);
  });

  test('битый JSON не роняет', () => {
    assert.equal(chat().parse(new TextEncoder().encode('{не json')), null);
  });

  test('пустой текст игнорируем', () => {
    assert.equal(chat().parse(incoming({ text: '   ' })), null);
  });

  test('без имени отправитель называется участником', () => {
    assert.equal(chat().parse(incoming({ name: '' }))?.name, 'участник');
  });
});
