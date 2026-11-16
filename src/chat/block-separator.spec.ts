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
});
