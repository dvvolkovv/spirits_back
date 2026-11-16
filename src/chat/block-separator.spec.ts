import { performance } from 'perf_hooks';
import { blockSeparator, BlockJoiner } from './block-separator';

describe('blockSeparator', () => {
  it.each([
    ['', 'Готово.', ''],
    ['  \n ', 'Готово.', ''],
    ['Сейчас посмотрю.', 'Готово.', '\n\n'],
    ['Сейчас посмотрю.  ', 'Готово.', '\n\n'],
    ['Сейчас посмотрю.\n', 'Готово.', '\n'],
    ['Сейчас посмотрю.', '\nГотово.', '\n'],
    ['Сейчас посмотрю.\n', '\nГотово.', ''],
    ['Сейчас посмотрю.\n\n', 'Готово.', ''],
    ['Сейчас посмотрю.\n \n', 'Готово.', ''],
    ['Сейчас посмотрю.', '\n\nГотово.', ''],
  ])('%j + %j → %j', (prev, next, sep) => {
    expect(blockSeparator(prev, next)).toBe(sep);
  });

  it('после склейки между блоками ровно одна пустая строка', () => {
    for (const [prev, next] of [['а.', 'б'], ['а.\n', 'б'], ['а.', '\nб'], ['а.\n', '\nб']]) {
      expect(prev + blockSeparator(prev, next) + next).toBe('а.\n\nб');
    }
  });

  /**
   * prev — весь накопленный ответ. Регулярка с откатом на длинной серии
   * пустых строк посреди ответа синхронно вешала event loop всего API
   * (2000 переносов — 1,9 с, 5000 — 24 с). Размеры — лесенкой: медленная
   * реализация падает на малом, а не вешает прогон — таймаут jest синхронный
   * код не прервёт.
   */
  it('длинный ответ с пустыми строками посреди — линейно, без зависания', () => {
    for (const n of [1000, 2000, 5000, 20000]) {
      const prev = 'А.' + '\n'.repeat(n) + 'Б.';
      const t0 = performance.now();
      const sep = blockSeparator(prev, 'В.');
      const ms = performance.now() - t0;
      expect(sep).toBe('\n\n');
      expect(ms).toBeLessThan(50);
    }
  }, 5000);
});

describe('BlockJoiner', () => {
  it('разделитель получает только первый кусок после шага работы', () => {
    const chunks: string[] = [];
    const j = new BlockJoiner(() => chunks.join(''));
    chunks.push(j.text('Сейчас посмотрю.'));
    j.tool();
    chunks.push(j.text('Гото'));
    chunks.push(j.text('во.'));
    expect(chunks.join('')).toBe('Сейчас посмотрю.\n\nГотово.');
  });

  it('шаг в самом начале ответа — без разделителя', () => {
    const chunks: string[] = [];
    const j = new BlockJoiner(() => chunks.join(''));
    j.tool();
    chunks.push(j.text('Готово.'));
    expect(chunks.join('')).toBe('Готово.');
  });

  it('пустой кусок не съедает разделитель', () => {
    const chunks: string[] = [];
    const j = new BlockJoiner(() => chunks.join(''));
    chunks.push(j.text('А.'));
    j.tool();
    chunks.push(j.text(''));
    chunks.push(j.text('Б.'));
    expect(chunks.join('')).toBe('А.\n\nБ.');
  });

  it('несколько шагов подряд — один разделитель', () => {
    const chunks: string[] = [];
    const j = new BlockJoiner(() => chunks.join(''));
    chunks.push(j.text('А.'));
    j.tool();
    j.tool();
    chunks.push(j.text('Б.'));
    expect(chunks.join('')).toBe('А.\n\nБ.');
  });

  // Кусок из одних пробелов и переносов шаг не «съедает»: разделитель
  // считается на первом куске с текстом, с учётом уже пришедших пробелов, —
  // между блоками ровно одна пустая строка.
  it.each([
    ['\n', 'Б.', 'А.\n\nБ.'],
    ['\n', '\nБ.', 'А.\n\nБ.'],
    ['\n\n', 'Б.', 'А.\n\nБ.'],
    [' ', 'Б.', 'А. \n\nБ.'],
    [' ', '\nБ.', 'А. \n\nБ.'],
  ])('пробельный кусок %j после шага, затем %j → %j', (ws, tail, joined) => {
    const chunks: string[] = [];
    const j = new BlockJoiner(() => chunks.join(''));
    chunks.push(j.text('А.'));
    j.tool();
    chunks.push(j.text(ws));
    chunks.push(j.text(tail));
    expect(chunks.join('')).toBe(joined);
    expect(chunks.join('')).not.toContain('\n\n\n');
  });
});
