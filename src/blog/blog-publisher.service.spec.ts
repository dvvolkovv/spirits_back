import { BlogPublisherService, buildPostUrl } from './blog-publisher.service';

const post = (over: any = {}) => ({
  id: 'p1', rubric: 'case', source: 'stats', sourceRef: null, topicKey: 'k', topicHint: null,
  lang: 'ru', title: 'Заголовок', body: 'Текст', imagePrompt: null,
  imageUrl: 'https://minio/i.png', status: 'approved', slotAt: null, publishedAt: null,
  reviewChatId: null, reviewMessageId: null, tgMessageId: null, tgUrl: null,
  attempts: 0, lastError: null, createdAt: '', updatedAt: '', ...over,
});

const settingsMock = () => ({ get: jest.fn().mockResolvedValue({ channelChatId: '-1001234567890', slotDays: [1], slotHourMsk: 10, imageStyle: '' }) });

describe('buildPostUrl', () => {
  it('публичный канал — ссылка по username', () => {
    expect(buildPostUrl({ username: 'linkeon', id: -100123 }, 42)).toBe('https://t.me/linkeon/42');
  });

  it('приватный канал — ссылка вида t.me/c/<id>', () => {
    expect(buildPostUrl({ id: -1001234567890 }, 42)).toBe('https://t.me/c/1234567890/42');
  });
});

describe('BlogPublisherService.publish', () => {
  it('захватывает пост и отправляет фото в канал', async () => {
    const pg = { query: jest.fn() };
    pg.query
      .mockResolvedValueOnce({ rows: [{ ...rawRow() }] })   // захват
      .mockResolvedValueOnce({ rows: [] });                  // финальный апдейт
    const tg = { sendPhoto: jest.fn().mockResolvedValue({ message_id: 42, chat: { id: -1001234567890 } }) };
    const svc = new BlogPublisherService(pg as any, tg as any, settingsMock() as any);

    const res = await svc.publish(post());
    expect(res).toEqual({ ok: true, tgMessageId: 42, tgUrl: 'https://t.me/c/1234567890/42' });
    expect(tg.sendPhoto).toHaveBeenCalledTimes(1);
  });

  it('проигравший захват не отправляет ничего — защита от двойной публикации', async () => {
    const pg = { query: jest.fn().mockResolvedValueOnce({ rows: [] }) };
    const tg = { sendPhoto: jest.fn() };
    const svc = new BlogPublisherService(pg as any, tg as any, settingsMock() as any);

    const res = await svc.publish(post());
    expect(res.ok).toBe(false);
    expect(tg.sendPhoto).not.toHaveBeenCalled();
    const claimSql = pg.query.mock.calls[0][0] as string;
    expect(claimSql).toContain("status = 'approved'");
  });

  it('пост без картинки не захватывается и не публикуется — иначе сгорят все три попытки', async () => {
    const pg = { query: jest.fn() };
    const tg = { sendPhoto: jest.fn() };
    const svc = new BlogPublisherService(pg as any, tg as any, settingsMock() as any);

    const res = await svc.publish(post({ imageUrl: null }));
    expect(res.ok).toBe(false);
    expect(pg.query).not.toHaveBeenCalled();
    expect(tg.sendPhoto).not.toHaveBeenCalled();
  });

  it('канал не настроен — не захватываем и не публикуем', async () => {
    const pg = { query: jest.fn() };
    const tg = { sendPhoto: jest.fn() };
    const settings = { get: jest.fn().mockResolvedValue({ channelChatId: null, slotDays: [1], slotHourMsk: 10, imageStyle: '' }) };
    const svc = new BlogPublisherService(pg as any, tg as any, settings as any);

    const res = await svc.publish(post());
    expect(res.ok).toBe(false);
    expect(pg.query).not.toHaveBeenCalled();
    expect(tg.sendPhoto).not.toHaveBeenCalled();
  });

  it('отказ Telegram записывает причину', async () => {
    const pg = { query: jest.fn() };
    pg.query.mockResolvedValueOnce({ rows: [rawRow({ attempts: 3 })] }).mockResolvedValueOnce({ rows: [] });
    const tg = { sendPhoto: jest.fn().mockRejectedValue(new Error('CHAT_WRITE_FORBIDDEN')) };
    const svc = new BlogPublisherService(pg as any, tg as any, settingsMock() as any);

    const res = await svc.publish(post());
    expect(res.ok).toBe(false);
    const lastSql = pg.query.mock.calls[1][0] as string;
    expect(lastSql).toContain("status = 'failed'");
    expect(pg.query.mock.calls[1][1]).toContain('CHAT_WRITE_FORBIDDEN');
  });

  it('первая неудача Telegram возвращает пост в approved для повторной попытки', async () => {
    const pg = { query: jest.fn() };
    pg.query.mockResolvedValueOnce({ rows: [rawRow({ attempts: 1 })] }).mockResolvedValueOnce({ rows: [] });
    const tg = { sendPhoto: jest.fn().mockRejectedValue(new Error('ETIMEDOUT')) };
    const svc = new BlogPublisherService(pg as any, tg as any, settingsMock() as any);

    await svc.publish(post());
    expect(pg.query.mock.calls[1][0]).toContain("status = 'approved'");
  });

  it('третья неудача подряд переводит пост в failed окончательно', async () => {
    const pg = { query: jest.fn() };
    pg.query.mockResolvedValueOnce({ rows: [rawRow({ attempts: 3 })] }).mockResolvedValueOnce({ rows: [] });
    const tg = { sendPhoto: jest.fn().mockRejectedValue(new Error('ETIMEDOUT')) };
    const svc = new BlogPublisherService(pg as any, tg as any, settingsMock() as any);

    await svc.publish(post());
    expect(pg.query.mock.calls[1][0]).toContain("status = 'failed'");
  });
});

function rawRow(over: any = {}) {
  return {
    id: 'p1', rubric: 'case', source: 'stats', source_ref: null, topic_key: 'k', topic_hint: null,
    lang: 'ru', title: 'Заголовок', body: 'Текст', image_prompt: null, image_url: 'https://minio/i.png',
    status: 'publishing', slot_at: null, published_at: null, review_chat_id: null, review_message_id: null,
    tg_message_id: null, tg_url: null, attempts: 1, last_error: null, created_at: '', updated_at: '',
    ...over,
  };
}
