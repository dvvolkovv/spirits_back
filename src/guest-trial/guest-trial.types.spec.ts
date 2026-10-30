import { DEFAULT_GUEST_LIMITS, parseLimitsPatch, parseMode, sanitizeLimits, toLimit } from './guest-trial.types';

describe('режим пробы', () => {
  it('знает только on и preview, остальное — off', () => {
    expect(parseMode('on')).toBe('on');
    expect(parseMode('preview')).toBe('preview');
    expect(parseMode('off')).toBe('off');
    expect(parseMode(undefined)).toBe('off');
    expect(parseMode('ON')).toBe('off');
    expect(parseMode(true)).toBe('off');
  });
});

describe('лимиты пробы', () => {
  it('без строки в базе — решения владельца 30.10', () => {
    expect(sanitizeLimits(undefined).limits).toEqual(DEFAULT_GUEST_LIMITS);
    expect(DEFAULT_GUEST_LIMITS).toMatchObject({
      answersPerTrial: 3, maxChars: 2000, trialsPerHour: 60, trialsPerDay: 200, answersPerHour: 100, answersPerDay: 300,
    });
  });

  it('принимает целые больше нуля, мусор называет', () => {
    const r = sanitizeLimits({ answersPerDay: 500, answersPerHour: '0', maxChars: 1.5, trialsPerDay: 'много', unknown: 7 });
    expect(r.limits.answersPerDay).toBe(500);
    expect(r.limits.answersPerHour).toBe(DEFAULT_GUEST_LIMITS.answersPerHour);
    expect(r.limits.maxChars).toBe(DEFAULT_GUEST_LIMITS.maxChars);
    expect(r.ignored.sort()).toEqual(['answersPerHour=0', 'maxChars=1.5', 'trialsPerDay=много']);
  });

  it('правка ложится поверх текущих значений, а не поверх умолчаний', () => {
    const base = { ...DEFAULT_GUEST_LIMITS, answersPerDay: 500 };
    expect(sanitizeLimits({ answersPerHour: 50 }, base).limits).toMatchObject({ answersPerDay: 500, answersPerHour: 50 });
  });
});

describe('toLimit — строго одно число лимита', () => {
  it('number и строка из цифр (после trim) — целое больше нуля', () => {
    expect(toLimit(5)).toBe(5);
    expect(toLimit('5')).toBe(5);
    expect(toLimit(' 42 ')).toBe(42);
  });

  it('остальное — null', () => {
    expect(toLimit(true)).toBeNull();
    expect(toLimit([5])).toBeNull();
    expect(toLimit(1.5)).toBeNull();
    expect(toLimit('0')).toBeNull();
    expect(toLimit('много')).toBeNull();
  });
});

describe('parseLimitsPatch — патч лимитов из админ-ручки', () => {
  it('не объект — пустой патч и явная причина', () => {
    for (const bad of [null, undefined, [], 'строка']) {
      expect(parseLimitsPatch(bad)).toEqual({ patch: {}, ignored: ['limits: ожидался объект'] });
    }
  });

  it('пустой объект — пустой патч без ignored', () => {
    expect(parseLimitsPatch({})).toEqual({ patch: {}, ignored: [] });
  });

  it('неизвестный ключ и кривое значение называются по-разному', () => {
    const r = parseLimitsPatch({ answersPerDay: 500, fooBar: 1, answersPerHour: '0' });
    expect(r.patch).toEqual({ answersPerDay: 500 });
    expect(r.ignored.sort()).toEqual(['answersPerHour=0', 'fooBar: неизвестный ключ']);
  });
});
