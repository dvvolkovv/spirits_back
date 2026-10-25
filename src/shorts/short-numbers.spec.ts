import { assistantsInWords, finalLine, numberWordsRu } from './short-numbers';

describe('numberWordsRu', () => {
  it.each([
    [0, 'ноль'], [1, 'один'], [9, 'девять'], [10, 'десять'], [11, 'одиннадцать'],
    [18, 'восемнадцать'], [20, 'двадцать'], [21, 'двадцать один'], [40, 'сорок'],
    [99, 'девяносто девять'], [100, 'сто'], [111, 'сто одиннадцать'], [205, 'двести пять'],
    [999, 'девятьсот девяносто девять'],
  ])('%i → %s', (n, words) => {
    expect(numberWordsRu(n)).toBe(words);
  });

  it('вне 0–999 и дробное — ошибка, а не тихая ерунда в озвучке', () => {
    expect(() => numberWordsRu(1000)).toThrow(/0–999/);
    expect(() => numberWordsRu(-1)).toThrow(/0–999/);
    expect(() => numberWordsRu(1.5)).toThrow(/0–999/);
  });
});

describe('assistantsInWords', () => {
  it('падеж — из Intl.PluralRules', () => {
    expect(assistantsInWords(18)).toBe('восемнадцать ассистентов');
    expect(assistantsInWords(21)).toBe('двадцать один ассистент');
    expect(assistantsInWords(22)).toBe('двадцать два ассистента');
    expect(assistantsInWords(11)).toBe('одиннадцать ассистентов');
  });
});

describe('finalLine', () => {
  it('совпадает с финалом принятого образца', () => {
    expect(finalLine(18)).toBe('Линкеон — восемнадцать ассистентов. Ссылка — в описании и в профиле.');
  });
});
