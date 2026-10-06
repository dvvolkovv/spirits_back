import { splitForSpeech } from './split';

/** Все непробельные символы по порядку — по ним сверяем, что текст не потерян. */
const squash = (s: string) => s.replace(/\s+/g, '');

describe('splitForSpeech', () => {
  it('короткий текст — один кусок как есть', () => {
    expect(splitForSpeech('Привет. Как дела?', 2000)).toEqual(['Привет. Как дела?']);
  });

  it('пустой и пробельный текст — ни одного куска', () => {
    expect(splitForSpeech('', 2000)).toEqual([]);
    expect(splitForSpeech('  \n ', 2000)).toEqual([]);
  });

  it('каждый кусок не длиннее лимита, и склейка сохраняет весь текст', () => {
    const text = 'Это предложение для проверки разбиения. '.repeat(200);
    const chunks = splitForSpeech(text, 2000);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
    expect(squash(chunks.join(' '))).toBe(squash(text));
  });

  it('режет по концу предложения, а не посреди слова', () => {
    const chunks = splitForSpeech('Первое предложение. '.repeat(150), 2000);
    expect(chunks[0].endsWith('.')).toBe(true);
    expect(chunks[1].startsWith('Первое')).toBe(true);
  });

  it('предпочитает границу абзаца', () => {
    const p1 = 'а'.repeat(1200) + '.';
    const p2 = 'Второй абзац. '.repeat(100);
    expect(splitForSpeech(`${p1}\n\n${p2}`, 2000)[0]).toBe(p1);
  });

  it('абзац в самом начале не дробит текст на лишний крошечный кусок', () => {
    const text = 'Заголовок\n' + 'слово '.repeat(400);
    const chunks = splitForSpeech(text, 2000);
    expect(chunks[0].startsWith('Заголовок')).toBe(true);
    expect(chunks[0].length).toBeGreaterThan(1000);
  });

  it('конец предложения с закрывающей кавычкой — граница после кавычки', () => {
    const text = 'Он сказал: «Готово.» '.repeat(120);
    const chunks = splitForSpeech(text, 2000);
    expect(chunks[0].endsWith('»')).toBe(true);
  });

  it('предложение длиннее лимита режется по пробелу', () => {
    const text = 'слово '.repeat(500).trim();
    const chunks = splitForSpeech(text, 2000);
    expect(chunks).toHaveLength(2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(2000);
      expect(c.startsWith('слово')).toBe(true);
      expect(c.endsWith('слово')).toBe(true);
    }
  });

  it('слово длиннее лимита режется жёстко', () => {
    expect(splitForSpeech('я'.repeat(4500), 2000).map((c) => c.length)).toEqual([2000, 2000, 500]);
  });

  it('лимит меньше единицы — ошибка, а не вечный цикл', () => {
    expect(() => splitForSpeech('текст', 0)).toThrow(RangeError);
  });
});
