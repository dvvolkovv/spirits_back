import { BlogController } from './blog.controller';
import { BadRequestException, ConflictException } from '@nestjs/common';

const res = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
};

const rawRow = (over: any = {}) => ({
  id: 'p1', rubric: 'case', source: 'stats', source_ref: null, topic_key: 'k', topic_hint: null,
  lang: 'ru', title: 'З', body: 'Т', image_prompt: 'сцена', image_url: 'u',
  status: 'pending_review', slot_at: null, published_at: null, review_chat_id: null, review_message_id: null,
  tg_message_id: null, tg_url: null, attempts: 0, last_error: null,
  created_at: '2026-09-21T10:00:00.000Z', updated_at: '2026-09-21T10:00:00.000Z', ...over,
});

const deps = () => ({
  pg: { query: jest.fn().mockResolvedValue({ rows: [rawRow()] }) },
  topics: { addTopic: jest.fn().mockResolvedValue({ id: 'new' }) },
  settings: { get: jest.fn().mockResolvedValue({ channelChatId: '-100', slotDays: [1, 3, 5], slotHourMsk: 10, imageStyle: '' }), update: jest.fn().mockResolvedValue({}) },
  images: { render: jest.fn().mockResolvedValue('https://minio/new.png') },
});

const make = (d: any) => new BlogController(d.pg, d.topics, d.settings, d.images);

describe('BlogController', () => {
  it('list отдаёт очередь', async () => {
    const d = deps(); const r = res();
    await make(d).action({ action: 'list' }, r);
    expect(r.status).toHaveBeenCalledWith(200);
  });

  // Сорвавшаяся публикация требует внимания — ей место в очереди. Если failed
  // попадёт в обе выборки, вкладка покажет один и тот же пост дважды.
  it('failed виден в очереди и не двоится в архиве', async () => {
    const d = deps(); const r = res();
    const c = make(d);
    await c.action({ action: 'list' }, r);
    await c.action({ action: 'archive' }, r);
    const [listSql, archiveSql] = d.pg.query.mock.calls.map((x: any[]) => String(x[0]));
    expect(listSql).not.toContain('failed');
    expect(archiveSql).not.toContain('failed');
  });

  it('add_topic заводит ручную тему с источником manual', async () => {
    const d = deps(); const r = res();
    await make(d).action({ action: 'add_topic', rubric: 'case', topic: 'про аренду' }, r);
    expect(d.topics.addTopic).toHaveBeenCalledWith(expect.objectContaining({ source: 'manual' }));
  });

  it('update_text с верной версией сохраняет текст', async () => {
    const d = deps(); const r = res();
    await make(d).action({
      action: 'update_text', id: 'p1', title: 'Новый', body: 'Новое',
      updatedAt: '2026-09-21T10:00:00.000Z',
    }, r);
    expect(d.pg.query.mock.calls[1][0]).toContain('UPDATE blog_post');
  });

  it('update_text с устаревшей версией отдаёт 409, а не затирает чужую правку', async () => {
    const d = deps(); const r = res();
    await expect(make(d).action({
      action: 'update_text', id: 'p1', title: 'Новый', body: 'Новое',
      updatedAt: '2026-09-21T09:00:00.000Z',
    }, r)).rejects.toBeInstanceOf(ConflictException);
  });

  it('approve назначает слот', async () => {
    const d = deps(); const r = res();
    await make(d).action({ action: 'approve', id: 'p1' }, r);
    expect(d.pg.query.mock.calls[1][0]).toContain("status = 'approved'");
  });

  it('неизвестное действие — 400', async () => {
    const d = deps(); const r = res();
    await make(d).action({ action: 'взорви_всё' }, r);
    expect(r.status).toHaveBeenCalledWith(400);
  });

  // --- машина состояний: админка не должна уметь то, чего не умеют кнопки в личке ---

  it('redraft опубликованного поста отклоняется и не пишет статус', async () => {
    const d = deps(); const r = res();
    d.pg.query = jest.fn().mockResolvedValue({ rows: [rawRow({ status: 'published' })] });
    await expect(make(d).action({ action: 'redraft', id: 'p1' }, r))
      .rejects.toBeInstanceOf(ConflictException);
    expect(d.pg.query.mock.calls.some((c: any[]) => /UPDATE blog_post/.test(c[0]))).toBe(false);
  });

  it('approve отклонённого поста отклоняется — мусор не уезжает в канал', async () => {
    const d = deps(); const r = res();
    d.pg.query = jest.fn().mockResolvedValue({ rows: [rawRow({ status: 'rejected' })] });
    await expect(make(d).action({ action: 'approve', id: 'p1' }, r))
      .rejects.toBeInstanceOf(ConflictException);
    expect(d.pg.query.mock.calls.some((c: any[]) => /UPDATE blog_post/.test(c[0]))).toBe(false);
  });

  it('reject опубликованного поста отклоняется — из канала он уже не исчезнет', async () => {
    const d = deps(); const r = res();
    d.pg.query = jest.fn().mockResolvedValue({ rows: [rawRow({ status: 'published' })] });
    await expect(make(d).action({ action: 'reject', id: 'p1' }, r))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('статус, уехавший между чтением и записью, не переписывается молча', async () => {
    const d = deps(); const r = res();
    d.pg.query = jest.fn()
      .mockResolvedValueOnce({ rows: [rawRow()] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(make(d).action({ action: 'approve', id: 'p1' }, r))
      .rejects.toBeInstanceOf(ConflictException);
  });

  // --- версия: сравнение по моменту времени, а не по написанию строки ---

  it('та же метка времени в другом написании не даёт ложный 409', async () => {
    const d = deps(); const r = res();
    await make(d).action({
      action: 'update_text', id: 'p1', title: 'Новый', body: 'Новое',
      updatedAt: '2026-09-21T10:00:00Z',
    }, r);
    expect(d.pg.query.mock.calls[1][0]).toContain('UPDATE blog_post');
  });

  it('add_topic с пустой темой — 400, а не идея с пустым ключом', async () => {
    const d = deps(); const r = res();
    await expect(make(d).action({ action: 'add_topic', rubric: 'case', topic: '   ' }, r))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(d.topics.addTopic).not.toHaveBeenCalled();
  });
});
