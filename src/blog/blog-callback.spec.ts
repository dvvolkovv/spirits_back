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
  it('три кнопки в одном ряду с id поста', () => {
    const kb = buildBlogKeyboard(ID);
    expect(kb.inline_keyboard).toHaveLength(1);
    expect(kb.inline_keyboard[0].map((b) => b.callback_data)).toEqual([
      `blog:ok:${ID}`, `blog:redo:${ID}`, `blog:no:${ID}`,
    ]);
  });

  it('callback_data укладывается в лимит Telegram в 64 байта', () => {
    for (const btn of buildBlogKeyboard(ID).inline_keyboard[0]) {
      expect(Buffer.byteLength(btn.callback_data, 'utf8')).toBeLessThanOrEqual(64);
    }
  });
});
