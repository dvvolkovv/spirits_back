import { tokenCostFor, cacheKeyFor, estimateDurationSec, maxCharsFor } from './speech.service';

describe('tokenCostFor', () => {
  it('округляет вверх до целых тысяч', () => {
    expect(tokenCostFor(1)).toBe(1000);
    expect(tokenCostFor(999)).toBe(1000);
    expect(tokenCostFor(1000)).toBe(1000);
    expect(tokenCostFor(1001)).toBe(2000);
    expect(tokenCostFor(5000)).toBe(5000);
  });
});

describe('cacheKeyFor', () => {
  it('одинаковые входы дают одинаковый ключ', () => {
    expect(cacheKeyFor('привет', 'zahar', 'ru')).toBe(cacheKeyFor('привет', 'zahar', 'ru'));
  });

  it('смена голоса даёт другой ключ', () => {
    expect(cacheKeyFor('привет', 'zahar', 'ru')).not.toBe(cacheKeyFor('привет', 'filipp', 'ru'));
  });

  it('смена языка даёт другой ключ', () => {
    expect(cacheKeyFor('hello', 'onyx', 'en')).not.toBe(cacheKeyFor('hello', 'onyx', 'de'));
  });

  it('смена текста даёт другой ключ', () => {
    expect(cacheKeyFor('привет', 'zahar', 'ru')).not.toBe(cacheKeyFor('пока', 'zahar', 'ru'));
  });
});

describe('estimateDurationSec', () => {
  it('оценивает по 15 символов в секунду', () => {
    expect(estimateDurationSec(150)).toBeCloseTo(10, 1);
  });
});

describe('maxCharsFor — потолок свой у каждого провайдера', () => {
  it('yandex — 2000 символов: 15 КБ лимит тела, кириллица раздувается в 6 раз', () => {
    expect(maxCharsFor('yandex')).toBe(2000);
  });

  it('openai — 4000 символов: у tts-1 лимит 4096 на input', () => {
    expect(maxCharsFor('openai')).toBe(4000);
  });

  it('потолок yandex реально влезает в 15 КБ тела на кириллице', () => {
    const params = new URLSearchParams();
    params.set('text', 'я'.repeat(maxCharsFor('yandex')));
    expect(Buffer.byteLength(params.toString())).toBeLessThan(15000);
  });

  it('вдвое больший текст в лимит уже НЕ влезает — проверка, что потолок не декоративный', () => {
    const params = new URLSearchParams();
    params.set('text', 'я'.repeat(maxCharsFor('yandex') * 2));
    expect(Buffer.byteLength(params.toString())).toBeGreaterThan(15000);
  });
});
