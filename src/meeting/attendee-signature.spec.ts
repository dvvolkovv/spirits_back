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
});
