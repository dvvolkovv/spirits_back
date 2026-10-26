import { buildReviewKeyboard, buildYoutubeKeyboard, parseShortCallback, parseYoutubeUrl, shortCommandText } from './short-callback';

const ID = '6f1c2a9e-0d4b-4c3e-9a51-3b2f7c8d9e10';

describe('кнопки ролика', () => {
  it('разбор: действие и id', () => {
    expect(parseShortCallback(`short:ok:${ID}`)).toEqual({ action: 'ok', shortId: ID });
    expect(parseShortCallback(`short:yt:${ID}`)).toEqual({ action: 'yt', shortId: ID });
  });

  it('чужие и кривые — null', () => {
    expect(parseShortCallback(`blog:ok:${ID}`)).toBeNull();
    expect(parseShortCallback(`short:boom:${ID}`)).toBeNull();
    expect(parseShortCallback('short:ok:')).toBeNull();
    expect(parseShortCallback('short:ok:not-a-uuid')).toBeNull();
  });

  it('два ряда по две кнопки, callback_data не длиннее 64 байт', () => {
    const kb = buildReviewKeyboard(ID).inline_keyboard;
    expect(kb.map((row) => row.length)).toEqual([2, 2]);
    expect(kb.flat().map((b) => b.callback_data)).toEqual([`short:ok:${ID}`, `short:note:${ID}`, `short:redo:${ID}`, `short:no:${ID}`]);
    for (const b of kb.flat()) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    expect(buildYoutubeKeyboard(ID).inline_keyboard[0][0].callback_data).toBe(`short:yt:${ID}`);
  });

  it('кнопка YouTube: callback_data не длиннее 64 байт', () => {
    const kb = buildYoutubeKeyboard(ID).inline_keyboard;
    for (const row of kb) for (const b of row) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
  });
});

describe('/short', () => {
  it('текст после команды — целиком, с переносами', () => {
    expect(shortCommandText('/short Как не потерять залог\nи договор')).toBe('Как не потерять залог\nи договор');
    expect(shortCommandText('/short@LinkeonTestBot тема')).toBe('тема');
    expect(shortCommandText('/short')).toBe('');
  });

  it('другие команды — не наши', () => {
    expect(shortCommandText('/shortcut x')).toBeNull();
    expect(shortCommandText('/case x')).toBeNull();
    expect(shortCommandText(undefined)).toBeNull();
  });
});

describe('ссылка YouTube', () => {
  it.each([
    ['https://youtube.com/shorts/AbCdEfGhIjK', 'AbCdEfGhIjK'],
    ['https://www.youtube.com/shorts/AbCdEfGhIjK?feature=share', 'AbCdEfGhIjK'],
    ['https://youtu.be/AbCdEfGhIjK', 'AbCdEfGhIjK'],
    ['https://m.youtube.com/watch?v=AbCdEfGhIjK&t=3', 'AbCdEfGhIjK'],
    ['Вот: https://youtube.com/shorts/AbCdEfGhIjK', 'AbCdEfGhIjK'],
  ])('%s', (text, id) => {
    expect(parseYoutubeUrl(text)).toEqual({ videoId: id, url: `https://youtube.com/shorts/${id}` });
  });

  it('не YouTube — null', () => {
    expect(parseYoutubeUrl('https://vk.com/clip-1_2')).toBeNull();
    expect(parseYoutubeUrl('ссылки нет')).toBeNull();
  });

  it('чужой домен, похожий на youtube — null', () => {
    expect(parseYoutubeUrl('https://notyoutube.com/shorts/AbCdEfGhIjK')).toBeNull();
    expect(parseYoutubeUrl('https://youtube.com.evil.ru/shorts/AbCdEfGhIjK')).toBeNull();
  });

  it.each([
    ['https://youtube.com/shorts/AbCdEfGhIjK.', 'AbCdEfGhIjK'],
    ['(https://youtube.com/shorts/AbCdEfGhIjK)', 'AbCdEfGhIjK'],
    ['смотри: https://youtube.com/shorts/AbCdEfGhIjK!', 'AbCdEfGhIjK'],
    ['https://youtube.com/shorts/AbCdEfGhIjK, готово', 'AbCdEfGhIjK'],
    ['Залил: https://youtu.be/AbCdEfGhIjK.', 'AbCdEfGhIjK'],
  ])('хвостовая пунктуация без пробела: %s', (text, id) => {
    expect(parseYoutubeUrl(text)).toEqual({ videoId: id, url: `https://youtube.com/shorts/${id}` });
  });

  it('домен без учёта регистра, id регистр сохраняет', () => {
    expect(parseYoutubeUrl('HTTPS://YOUTUBE.COM/SHORTS/AbCdEfGhIjK')).toEqual({
      videoId: 'AbCdEfGhIjK',
      url: 'https://youtube.com/shorts/AbCdEfGhIjK',
    });
  });
});
