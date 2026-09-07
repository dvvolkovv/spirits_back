import { canonicalJson, verifyAttendeeSignature } from './attendee-signature';
import { createHmac } from 'crypto';

const SECRET = 'test-secret';
const sign = (payload: unknown) =>
  createHmac('sha256', SECRET).update(canonicalJson(payload), 'utf8').digest('base64');

describe('canonicalJson', () => {
  it('сортирует ключи на всех уровнях', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('не ставит пробелов', () => {
    expect(canonicalJson({ a: [1, 2] })).toBe('{"a":[1,2]}');
  });

  it('порядок элементов массива сохраняет', () => {
    // Массив — это данные, а не набор: сортировка здесь исказила бы payload.
    expect(canonicalJson({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
  });

  it('null и вложенную пустоту не теряет', () => {
    expect(canonicalJson({ a: null, b: {}, c: [] })).toBe('{"a":null,"b":{},"c":[]}');
  });
});

describe('verifyAttendeeSignature', () => {
  const payload = { bot_id: 'b1', trigger: 'bot.state_change', data: { new_state: 'joined' } };

  it('принимает верную подпись', () => {
    expect(verifyAttendeeSignature(SECRET, payload, sign(payload))).toBe(true);
  });

  it('подпись не зависит от порядка ключей в присланном JSON', () => {
    // Ровно ради этого канонизация и нужна: Django пересобирает JSON своим
    // сериализатором, и байты его вывода нашим не равны.
    const reordered = { data: { new_state: 'joined' }, trigger: 'bot.state_change', bot_id: 'b1' };
    expect(verifyAttendeeSignature(SECRET, reordered, sign(payload))).toBe(true);
  });

  it('отвергает чужую подпись', () => {
    expect(verifyAttendeeSignature(SECRET, payload, sign({ bot_id: 'other' }))).toBe(false);
  });

  it('отвергает подмену данных', () => {
    const tampered = { ...payload, data: { new_state: 'left' } };
    expect(verifyAttendeeSignature(SECRET, tampered, sign(payload))).toBe(false);
  });

  it('мусор вместо подписи — false, а не исключение', () => {
    // Ручка обязана отвечать 401, а не 500.
    expect(verifyAttendeeSignature(SECRET, payload, '')).toBe(false);
    expect(verifyAttendeeSignature(SECRET, payload, 'не base64!!')).toBe(false);
    expect(verifyAttendeeSignature(SECRET, payload, undefined as any)).toBe(false);
  });

  it('сходится с подписью, посчитанной настоящим Python', () => {
    // Золотой вектор. Остальные тесты этого describe считают подпись той же
    // canonicalJson, что и проверяемый код, — то есть доказывают
    // самосогласованность, а не совместимость с Attendee. Этот вектор
    // посчитан вне нашего кода, Python 3.13:
    //
    //   canon = json.dumps(payload, sort_keys=True, ensure_ascii=False,
    //                      separators=(",", ":"))
    //   base64(hmac.new(b'test-secret', canon.encode('utf-8'), sha256).digest())
    //
    // Payload — как настоящее событие participant_events.join_leave, с
    // кириллицей в имени и намеренно неотсортированными ключами.
    const payload = {
      trigger: 'participant_events.join_leave',
      bot_id: 'bot_1',
      idempotency_key: 'k1',
      bot_metadata: { callId: 'c1' },
      data: {
        participant_name: 'Сергей',
        participant_uuid: 'u1',
        event_type: 'join',
        timestamp_ms: 1757222400000,
      },
    };
    expect(canonicalJson(payload)).toBe(
      '{"bot_id":"bot_1","bot_metadata":{"callId":"c1"},"data":{"event_type":"join",' +
      '"participant_name":"Сергей","participant_uuid":"u1","timestamp_ms":1757222400000},' +
      '"idempotency_key":"k1","trigger":"participant_events.join_leave"}',
    );
    expect(verifyAttendeeSignature('test-secret', payload,
      'Jk7s1DxeUQ5yFdScDKoBCTkZNNKESJ3gHAV2bh6wD9o=')).toBe(true);
  });
});
