import axios from 'axios';
import { BlogPublisherService, buildPostUrl } from './blog-publisher.service';

jest.mock('axios');

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
  beforeEach(() => {
    jest.clearAllMocks();
    (axios.get as jest.Mock).mockResolvedValue({ data: Buffer.from('png-bytes') });
  });

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

  /**
   * `published` — терминальный статус: замечания к этому посту больше никто
   * не прочтёт, а в архиве админки они висели бы как незакрытые претензии к
   * уже вышедшему тексту.
   */
  it('опубликованный пост остаётся без замечаний', async () => {
    const pg = { query: jest.fn() };
    pg.query.mockResolvedValueOnce({ rows: [rawRow()] }).mockResolvedValueOnce({ rows: [] });
    const tg = { sendPhoto: jest.fn().mockResolvedValue({ message_id: 42, chat: { id: -1001234567890 } }) };
    const svc = new BlogPublisherService(pg as any, tg as any, settingsMock() as any);

    await svc.publish(post());

    expect(String(pg.query.mock.calls[1][0])).toContain("editor_notes = '{}'");
  });

  /** Сорвавшаяся отправка — не повод терять правки: пост ещё вернётся в очередь. */
  it('сорвавшаяся публикация замечания не трогает', async () => {
    const pg = { query: jest.fn() };
    pg.query.mockResolvedValueOnce({ rows: [rawRow({ attempts: 1 })] }).mockResolvedValueOnce({ rows: [] });
    const tg = { sendPhoto: jest.fn().mockRejectedValue(new Error('ETIMEDOUT')) };
    const svc = new BlogPublisherService(pg as any, tg as any, settingsMock() as any);

    await svc.publish(post());

    expect(String(pg.query.mock.calls[1][0])).not.toContain('editor_notes');
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

  /**
   * Ссылкой картинку отдавать нельзя: Telegram скачивает её своими серверами,
   * а my.linkeon.io живёт за РФ-edge Selectel — фетчер Telegram до него не
   * доходит и отвечает 400 «failed to get HTTP URL content». Тот же файл
   * мультипартом принимается с первого раза (проверено на проде).
   */
  it('в канал уходят байты картинки, а не ссылка', async () => {
    const pg = { query: jest.fn() };
    pg.query.mockResolvedValueOnce({ rows: [rawRow()] }).mockResolvedValueOnce({ rows: [] });
    const tg = { sendPhoto: jest.fn().mockResolvedValue({ message_id: 42, chat: { id: -1001234567890 } }) };
    const svc = new BlogPublisherService(pg as any, tg as any, settingsMock() as any);

    await svc.publish(post());

    expect(axios.get).toHaveBeenCalledWith(
      'https://minio/i.png',
      expect.objectContaining({ responseType: 'arraybuffer' }),
    );
    const [chatId, photo] = tg.sendPhoto.mock.calls[0];
    expect(chatId).toBe(-1001234567890);
    expect(Buffer.isBuffer(photo)).toBe(true);
    expect((photo as Buffer).toString()).toBe('png-bytes');
  });

  it('картинка не скачалась — в канал ничего не ушло, пост вернулся в очередь', async () => {
    (axios.get as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));
    const pg = { query: jest.fn() };
    pg.query.mockResolvedValueOnce({ rows: [rawRow({ attempts: 1 })] }).mockResolvedValueOnce({ rows: [] });
    const tg = { sendPhoto: jest.fn() };
    const svc = new BlogPublisherService(pg as any, tg as any, settingsMock() as any);

    const res = await svc.publish(post());

    expect(res.ok).toBe(false);
    expect(tg.sendPhoto).not.toHaveBeenCalled();
    expect(pg.query.mock.calls[1][0]).toContain("status = 'approved'");
    expect(pg.query.mock.calls[1][1][1]).toContain('ECONNREFUSED');
  });

  it('недоступная картинка на исчерпанных попытках роняет пост в failed', async () => {
    (axios.get as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));
    const pg = { query: jest.fn() };
    pg.query.mockResolvedValueOnce({ rows: [rawRow({ attempts: 3 })] }).mockResolvedValueOnce({ rows: [] });
    const tg = { sendPhoto: jest.fn() };
    const svc = new BlogPublisherService(pg as any, tg as any, settingsMock() as any);

    await svc.publish(post());

    expect(tg.sendPhoto).not.toHaveBeenCalled();
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
