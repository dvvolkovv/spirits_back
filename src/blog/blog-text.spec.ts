import { buildCaption, CAPTION_LIMIT } from './blog-text';

describe('buildCaption', () => {
  it('короткий пост склеивается заголовком и текстом', () => {
    expect(buildCaption('Заголовок', 'Тело поста')).toBe('Заголовок\n\nТело поста');
  });

  it('длинный пост обрезается до лимита', () => {
    const body = 'я'.repeat(2000);
    const caption = buildCaption('Заголовок', body);
    expect(caption.length).toBeLessThanOrEqual(CAPTION_LIMIT);
  });

  it('обрезка идёт по границе предложения, а не посреди слова', () => {
    const body = 'Первое предложение. ' + 'а'.repeat(CAPTION_LIMIT) + '. Хвост.';
    const caption = buildCaption('Т', body);
    expect(caption.endsWith('Первое предложение.')).toBe(true);
  });

  it('если границы предложения нет — обрезает по слову и ставит многоточие', () => {
    const body = Array(400).fill('слово').join(' ');
    const caption = buildCaption('Т', body);
    expect(caption.length).toBeLessThanOrEqual(CAPTION_LIMIT);
    expect(caption.endsWith('…')).toBe(true);
    expect(caption).not.toMatch(/сло…$/);
  });

  it('заголовок без тела не падает', () => {
    expect(buildCaption('Только заголовок', '')).toBe('Только заголовок');
  });

  it('реалистичная проза обрезается по концу предложения, а не посреди фразы', () => {
    const body = Array(30).fill('Человек приходит с конкретной задачей и получает разбор по шагам.').join(' ');
    const caption = buildCaption('Заголовок', body);
    expect(caption.length).toBeLessThanOrEqual(CAPTION_LIMIT);
    expect(caption.endsWith('.')).toBe(true);
    expect(caption.endsWith('…')).toBe(false);
  });
});
