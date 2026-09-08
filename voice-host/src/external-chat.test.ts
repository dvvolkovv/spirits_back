import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ExternalRoomChat } from './external-chat.js';

const URL = 'https://api.talerid.io/voice/rooms/personal-c79530ed-36fc367a/chat';
const NAME = 'Роман · ассистент Дмитрий';
/** Фиксированный seed — иначе clientMsgId непредсказуем и его не сверить. */
const SEED = 'testseed';

/** Ответ их ручки на отправку, снятый живьём 08.09.2026. */
const created = () => ({ ok: true, status: 201, json: async () => ({ ts: 1788851503527, seq: 1, msgId: 'c_628e43d4_lnk-testseed-1' }) });

const pack = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));

/** Настоящий пакет из их комнаты, снятый живьём 08.09.2026. */
const incoming = (over: Record<string, unknown> = {}) =>
  pack({
    type: 'chat_message',
    msgId: 'server_f46cf041-b5da-4bb3-918a-af832a2d4255',
    text: 'Вот документ: https://linkeon.io/doc/42',
    name: 'Дмитрий Волков',
    ts: 1788768440123,
    seq: 7,
    ...over,
  });

const chatWith = (impl: any) => new ExternalRoomChat(URL, 'jwt.body.sig', NAME, impl, SEED);

describe('send', () => {
  test('шлёт текст с Bearer, своим именем и своим clientMsgId', async () => {
    const calls: any[] = [];
    const chat = chatWith(async (u: any, i: any) => { calls.push([String(u), i]); return created(); });

    assert.equal(await chat.send('Документ готов'), 'sent');
    const [url, init] = calls[0];
    assert.equal(url, URL);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer jwt.body.sig');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(init.body), {
      text: 'Документ готов', name: NAME, clientMsgId: 'lnk-testseed-1',
    });
    // Тул исполняется синхронно и держит разговор: без таймаута зависшая
    // ручка молчала бы всю встречу на undici-дефолте в 300 секунд.
    assert.ok(init.signal, 'таймаут отправки не выставлен');
  });

  test('каждое сообщение получает свой clientMsgId', async () => {
    const ids: string[] = [];
    const chat = chatWith(async (_u: any, i: any) => { ids.push(JSON.parse(i.body).clientMsgId); return created(); });
    await chat.send('раз');
    await chat.send('два');
    assert.deepEqual(ids, ['lnk-testseed-1', 'lnk-testseed-2']);
  });

  test('текст длиннее их потолка обрезается, а не отбивается', async () => {
    // У них 500 знаков, дальше 400. Обрезать молча лучше, чем возвращать
    // модели отказ: сообщение без хвоста доходит, отказ — нет.
    let sent = '';
    const chat = chatWith(async (_u: any, i: any) => { sent = JSON.parse(i.body).text; return created(); });
    assert.equal(await chat.send('я'.repeat(900)), 'sent');
    assert.equal(sent.length, 500);
    assert.ok(sent.endsWith('…'));
  });

  test('пустой текст никуда не шлёт', async () => {
    let called = 0;
    const chat = chatWith(async () => { called++; return created(); });
    assert.equal(await chat.send('   '), 'failed');
    assert.equal(called, 0);
  });

  test('429 отличается от прочих отказов', async () => {
    // Единственный случай, когда повтор осмыслен: их потолок — 10 сообщений
    // за 10 секунд. Модель должна услышать «подожди», а не «не получилось».
    const chat = chatWith(async () => ({ ok: false, status: 429, text: async () => 'too many chat messages, slow down' }));
    assert.equal(await chat.send('привет'), 'rate_limited');
  });

  test('403 не исключение, а failed', async () => {
    const chat = chatWith(async () => ({ ok: false, status: 403, text: async () => 'No access to this room' }));
    assert.equal(await chat.send('привет'), 'failed');
  });

  test('упавшая сеть тоже failed', async () => {
    const chat = chatWith(async () => { throw new Error('ECONNREFUSED'); });
    assert.equal(await chat.send('привет'), 'failed');
  });
});

describe('parse', () => {
  const chat = () => chatWith(async () => created());

  test('разбирает настоящий пакет их комнаты', () => {
    assert.deepEqual(chat().parse(incoming()), {
      text: 'Вот документ: https://linkeon.io/doc/42',
      name: 'Дмитрий Волков',
      ts: 1788768440123,
      seq: 7,
    });
  });

  test('своё эхо отбрасывает по clientMsgId', async () => {
    // Сверяться с ответом на POST нельзя: эхо приходит РАНЬШЕ, чем резолвится
    // промис отправки (снято живьём 07.09.2026).
    const c = chat();
    await c.send('моё сообщение');
    assert.equal(c.parse(incoming({ clientMsgId: 'lnk-testseed-1', name: NAME })), null);
  });

  test('участника с тем же именем НЕ глушит', () => {
    // Раньше эхо отсеивалось по имени, и живой человек, назвавшийся как
    // ассистент, пропал бы из разговора молча.
    assert.equal(chat().parse(incoming({ name: NAME }))?.name, NAME);
  });

  test('чужой clientMsgId не считается своим', () => {
    assert.equal(chat().parse(incoming({ clientMsgId: 'lnk-другойбот-1' }))?.name, 'Дмитрий Волков');
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

describe('history', () => {
  /** Ответ их ленты, форма из их документа для интеграторов. */
  const feed = (messages: any[]) => ({
    ok: true, status: 200,
    json: async () => ({ messages, seq: messages.length, truncated: false }),
  });

  test('читает ленту без since — состояние встречи на момент входа', async () => {
    const calls: any[] = [];
    const chat = chatWith(async (u: any, i: any) => {
      calls.push([String(u), i]);
      return feed([
        { msgId: 's1', text: 'начали без Романа', name: 'Дмитрий', ts: 1, seq: 1, own: false },
        { msgId: 's2', text: 'ага', name: 'Анна', ts: 2, seq: 2, own: false },
      ]);
    });

    const rows = await chat.history();
    assert.equal(String(calls[0][0]), URL, 'since не добавляем — нужна вся лента');
    assert.equal(calls[0][1].method, undefined, 'чтение это GET');
    assert.equal(calls[0][1].headers.Authorization, 'Bearer jwt.body.sig');
    assert.deepEqual(rows.map((r) => `${r.name}: ${r.text}`), [
      'Дмитрий: начали без Романа', 'Анна: ага',
    ]);
  });

  test('свои сообщения из ленты убирает — и по own, и по clientMsgId', async () => {
    // own их сервер считает по токену и теряет при переподключении: после
    // нового /join наши же сообщения вернутся с own: false. Поэтому две
    // проверки, а не одна.
    const chat = chatWith(async () => feed([
      { text: 'моё по own', name: 'Роман', ts: 1, seq: 1, own: true },
      { text: 'моё после переподключения', name: 'Роман', ts: 2, seq: 2, own: false, clientMsgId: 'lnk-testseed-4' },
      { text: 'чужое', name: 'Анна', ts: 3, seq: 3, own: false },
    ]));
    assert.deepEqual((await chat.history()).map((r) => r.text), ['чужое']);
  });

  test('пустая лента — пустой список, а не отказ', async () => {
    const chat = chatWith(async () => feed([]));
    assert.deepEqual(await chat.history(), []);
  });

  test('недоступная лента не рушит вход во встречу', async () => {
    // История приятна, но встреча важнее: без неё Роман просто не знает, что
    // писали до него.
    const chat = chatWith(async () => { throw new Error('ETIMEDOUT'); });
    assert.deepEqual(await chat.history(), []);
  });

  test('503 тоже пустой список', async () => {
    const chat = chatWith(async () => ({ ok: false, status: 503, text: async () => 'storage down' }));
    assert.deepEqual(await chat.history(), []);
  });
});
