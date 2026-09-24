import { parseBlogCallback, buildBlogKeyboard } from './blog-callback';

const ID = '11111111-2222-3333-4444-555555555555';

describe('parseBlogCallback', () => {
  it('разбирает одобрение', () => {
    expect(parseBlogCallback(`blog:ok:${ID}`)).toEqual({ action: 'ok', postId: ID });
  });

  it('разбирает переписать и в мусор', () => {
    expect(parseBlogCallback(`blog:redo:${ID}`)!.action).toBe('redo');
    expect(parseBlogCallback(`blog:no:${ID}`)!.action).toBe('no');
  });

  it('разбирает замечание', () => {
    expect(parseBlogCallback(`blog:note:${ID}`)).toEqual({ action: 'note', postId: ID });
  });

  it('чужой префикс — null, чтобы не перехватывать кнопки ассистентов', () => {
    expect(parseBlogCallback(`agent:${ID}`)).toBeNull();
    expect(parseBlogCallback('lang:ru')).toBeNull();
  });

  it('неизвестное действие — null', () => {
    expect(parseBlogCallback(`blog:drop:${ID}`)).toBeNull();
  });

  it('пустая строка — null', () => {
    expect(parseBlogCallback('')).toBeNull();
  });
});

describe('buildBlogKeyboard', () => {
  /**
   * Четыре кнопки в одном ряду на телефоне сжимаются до обрезков подписей.
   * Два ряда по две: сверху «что делать с этим текстом», снизу «переделать
   * целиком или выбросить».
   */
  it('четыре кнопки в два ряда по две, с id поста', () => {
    const kb = buildBlogKeyboard(ID);
    expect(kb.inline_keyboard.map((row) => row.map((b) => b.callback_data))).toEqual([
      [`blog:ok:${ID}`, `blog:note:${ID}`],
      [`blog:redo:${ID}`, `blog:no:${ID}`],
    ]);
  });

  it('кнопка замечания так и подписана', () => {
    const note = buildBlogKeyboard(ID).inline_keyboard.flat().find((b) => b.callback_data === `blog:note:${ID}`);
    expect(note?.text).toBe('✍️ Замечание');
  });

  /**
   * Лимит проверяется по ВСЕМ кнопкам всех рядов. Прежняя редакция смотрела
   * только в первый ряд, и кнопка во втором ряду этим тестом не охватывалась
   * вовсе. Число кнопок сверяется, чтобы цикл не прошёл «зелёным» по пустому
   * списку.
   */
  it('callback_data каждой кнопки во всех рядах укладывается в лимит Telegram в 64 байта', () => {
    const buttons = buildBlogKeyboard(ID).inline_keyboard.flat();
    expect(buttons).toHaveLength(4);
    for (const btn of buttons) {
      expect(Buffer.byteLength(btn.callback_data, 'utf8')).toBeLessThanOrEqual(64);
    }
  });

  /**
   * Кнопка, которую парсер не узнаёт, — мёртвая: блог вернёт «не моё», и
   * нажатие так и повиснет часиками без ответа.
   */
  it('каждая кнопка разбирается обратно в своё действие', () => {
    for (const btn of buildBlogKeyboard(ID).inline_keyboard.flat()) {
      const parsed = parseBlogCallback(btn.callback_data);
      expect(parsed).not.toBeNull();
      expect(parsed!.postId).toBe(ID);
      expect(btn.callback_data).toBe(`blog:${parsed!.action}:${ID}`);
    }
  });
});
