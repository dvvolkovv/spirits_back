import { DEFAULT_GUEST_LIMITS, parseMode, sanitizeLimits } from './guest-trial.types';

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
