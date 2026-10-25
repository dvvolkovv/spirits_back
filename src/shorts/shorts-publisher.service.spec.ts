import { InputFile } from 'grammy';
import { buildYoutubeKeyboard } from './short-callback';
import { ShortsPublisherService } from './shorts-publisher.service';

const ID = '6f1c2a9e-0d4b-4c3e-9a51-3b2f7c8d9e10';
const OWNER = 777;

/** База в миниатюре: ровно те запросы, что делает публикатор. */
function fakeDb(over: Record<string, any> = {}) {
  const v: any = {
    id: ID, rubric: 'assistant', angle: 'calm', source: 'manual', topic_key: 't', title: 'Залог', slug: 'zalog_ab12',
    status: 'approved', attempts: 0, video_key: 'shorts/v/video.mp4', cover_key: 'shorts/v/cover.jpg', duration_ms: 44000,
    captions: { telegram: 'TG-подпись', vk: 'VK', youtube: { title: 'YT-заголовок', description: 'YT-описание', tags: ['аренда'] } },
    ...over,
  };
  const pubs = new Map<string, any>();
  const query = jest.fn(async (sql: string, p: any[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith("UPDATE short_video SET status = 'publishing'")) {
      if (v.status !== 'approved') return { rows: [] };
      v.status = 'publishing';
      v.attempts += 1;
      return { rows: [{ ...v }] };
    }
    if (s.startsWith('INSERT INTO short_publication')) {
      if (!pubs.has(p[1])) pubs.set(p[1], { short_id: p[0], platform: p[1], status: 'pending', attempts: 0 });
      return { rows: [] };
    }
    if (s.startsWith("UPDATE short_publication SET status = 'publishing'")) {
      const row = pubs.get(p[1]);
      if (!row || !['pending', 'failed'].includes(row.status)) return { rows: [] };
      row.status = 'publishing';
      row.attempts += 1;
      return { rows: [{ ...row }] };
    }
    if (s.startsWith('UPDATE short_publication SET status = $3')) {
      Object.assign(pubs.get(p[1]), { status: p[2], external_id: p[3], url: p[4], last_error: null });
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith("UPDATE short_publication SET status = 'failed'")) {
      Object.assign(pubs.get(p[1]), { status: 'failed', last_error: p[2] });
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('SELECT * FROM short_publication')) return { rows: [...pubs.values()].map((r) => ({ ...r })) };
    const m = s.match(/^UPDATE short_video SET status = '(published|approved|failed)'/);
    if (m) {
      v.status = m[1];
      if (m[1] !== 'published') v.last_error = p[1];
      if (m[1] === 'failed') v.failed_from = 'publishing';
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`неожиданный запрос: ${s}`);
  });
  return { query, v, pubs };
}

function setup(db = fakeDb(), channel: string | null = '-1003290853538') {
  const tg = {
    sendVideo: jest.fn(async () => ({ message_id: 501, chat: { id: -1003290853538, username: 'linkeontest' } })),
    sendDocument: jest.fn(async () => ({ message_id: 601 })),
    sendMessage: jest.fn(async () => ({ message_id: 602 })),
  };
  const storage = { download: jest.fn(async () => Buffer.from('bytes')) };
  const settings = { get: jest.fn(async () => ({ platforms: ['telegram', 'youtube'], tgChannelChatId: channel })) };
  const svc = new ShortsPublisherService({ query: db.query } as any, tg as any, storage as any, settings as any);
  return { svc, tg, db };
}

describe('ShortsPublisherService.publish', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.BLOG_APPROVER_TG_ID = String(OWNER);
    delete process.env.SHORTS_STAND;
  });
  afterAll(() => {
    process.env = env;
  });

  it('Telegram байтами с обложкой, затем набор YouTube; ролик опубликован', async () => {
    const { svc, tg, db } = setup();
    await svc.publish(ID);

    const [chat, bytes, opts] = tg.sendVideo.mock.calls[0] as any[];
    expect(chat).toBe(-1003290853538);
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(opts).toMatchObject({ caption: 'TG-подпись', supports_streaming: true, width: 1080, height: 1920, duration: 44 });
    expect(opts.thumbnail).toBeInstanceOf(InputFile);
    expect(db.pubs.get('telegram')).toMatchObject({ status: 'published', external_id: '501', url: 'https://t.me/linkeontest/501' });

    const [docChat, , filename] = tg.sendDocument.mock.calls[0] as any[];
    expect([docChat, filename]).toEqual([OWNER, 'linkeon-zalog_ab12.mp4']);
    const [msgChat, text, msgOpts] = tg.sendMessage.mock.calls[0] as any[];
    expect(msgChat).toBe(OWNER);
    expect(text).toContain('YouTube — заголовок:\nYT-заголовок');
    expect(text).toContain('YT-описание');
    expect(msgOpts.reply_markup).toEqual(buildYoutubeKeyboard(ID));
    expect(db.pubs.get('youtube')).toMatchObject({ status: 'manual_pending', external_id: '602' });
    expect(db.v.status).toBe('published');
  });

  it('канал не настроен — Telegram упал, набора YouTube нет, ролик ждёт повтора', async () => {
    const { svc, tg, db } = setup(fakeDb(), null);
    await svc.publish(ID);
    expect(tg.sendVideo).not.toHaveBeenCalled();
    expect(tg.sendDocument).not.toHaveBeenCalled();
    expect(db.pubs.get('telegram').status).toBe('failed');
    expect(db.v.status).toBe('approved');
    expect(db.v.last_error).toMatch(/telegram: канал Telegram не настроен/);
  });

  it('третья неудачная попытка — failed с этапом publishing', async () => {
    const { svc, db } = setup(fakeDb({ attempts: 2 }), null);
    await svc.publish(ID);
    expect([db.v.status, db.v.failed_from]).toEqual(['failed', 'publishing']);
  });

  it('повтор шлёт только упавшее: Telegram второй раз не уходит', async () => {
    const { svc, tg, db } = setup();
    tg.sendDocument.mockRejectedValueOnce(new Error('файл не принят'));
    await svc.publish(ID);
    expect(db.v.status).toBe('approved');
    await svc.publish(ID);
    expect(tg.sendVideo).toHaveBeenCalledTimes(1);
    expect(tg.sendDocument).toHaveBeenCalledTimes(2);
    expect(db.v.status).toBe('published');
  });

  it('ролик не в approved — ничего не отправляется', async () => {
    const { svc, tg } = setup(fakeDb({ status: 'pending_review' }));
    await svc.publish(ID);
    expect(tg.sendVideo).not.toHaveBeenCalled();
  });
});
