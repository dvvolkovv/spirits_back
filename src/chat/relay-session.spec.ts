import { relaySessionKey } from './relay-session';
import { relaySessionForProfiling } from './relay-prompt-privacy';

describe('relaySessionKey', () => {
  it('обычный ход: язык — часть ключа', () => {
    expect(relaySessionKey('u1', '12', 'ru')).toBe('u1_12_ru');
    expect(relaySessionKey('u1', '12', 'en')).toBe('u1_12_en');
  });

  it('изолированная сессия пинга перебивает всё', () => {
    expect(relaySessionKey('u1', '12', 'ru', 'u1_12_fresh_1786468316338'))
      .toBe('u1_12_fresh_1786468316338');
  });
});

describe('relaySessionKey: точка «Чистого листа»', () => {
  const R = new Date(1794804919138);

  it('без точки — прежний ключ: живые сессии не теряют память при выкате', () => {
    expect(relaySessionKey('u1', '10', 'ru')).toBe('u1_10_ru');
    expect(relaySessionKey('u1', '10', 'ru', undefined, null)).toBe('u1_10_ru');
  });

  it('с точкой — новая сессия: релей не резюмит старую память', () => {
    expect(relaySessionKey('u1', '10', 'ru', undefined, R)).toBe('u1_10_ru_r1794804919138');
  });

  it('битая точка (Invalid Date) — не прежний ключ: fail-closed', () => {
    // Точка была, но прочиталась мусором. Вернуть прежний ключ — значит
    // зарезюмить сессию со всей памятью до точки, то есть молча отменить
    // «Чистый лист». Лучше уж новая сессия без памяти, чем старая с ней.
    expect(relaySessionKey('u1', '10', 'ru', undefined, new Date(NaN))).not.toBe('u1_10_ru');
  });

  it('изолированная сессия пинга перебивает точку', () => {
    expect(relaySessionKey('u1', '10', 'ru', 'u1_10_fresh_1', R)).toBe('u1_10_fresh_1');
  });

  it('суффикс запрета профилирования встаёт после точки', () => {
    expect(relaySessionForProfiling(relaySessionKey('u1', '10', 'ru', undefined, R), false))
      .toBe('u1_10_ru_r1794804919138_noprofiling');
  });
});
