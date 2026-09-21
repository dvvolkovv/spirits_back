import { BlogSettingsService } from './blog-settings.service';

const pgMock = () => ({ query: jest.fn() });

describe('BlogSettingsService', () => {
  it('читает строку настроек и приводит типы', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValue({ rows: [{
      channel_chat_id: '-1001234567890', slot_days: [1, 3, 5],
      slot_hour_msk: 10, image_style: 'плоская иллюстрация',
    }] });
    const svc = new BlogSettingsService(pg as any);
    const s = await svc.get();
    expect(s.channelChatId).toBe('-1001234567890');
    expect(s.slotDays).toEqual([1, 3, 5]);
    expect(s.slotHourMsk).toBe(10);
  });

  it('если строки нет — отдаёт дефолты, а не падает', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValue({ rows: [] });
    const svc = new BlogSettingsService(pg as any);
    const s = await svc.get();
    expect(s.slotDays).toEqual([1, 3, 5]);
    expect(s.channelChatId).toBeNull();
  });

  it('обновление пишет только переданные поля', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValue({ rows: [{
      channel_chat_id: '-100', slot_days: [2, 4], slot_hour_msk: 9, image_style: '',
    }] });
    const svc = new BlogSettingsService(pg as any);
    await svc.update({ slotDays: [2, 4] });
    const sql = pg.query.mock.calls[0][0] as string;
    expect(sql).toContain('slot_days');
    expect(sql).not.toContain('channel_chat_id');
  });

  it('пустое обновление не ходит в базу', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValue({ rows: [{ slot_days: [1, 3, 5], slot_hour_msk: 10, image_style: '' }] });
    const svc = new BlogSettingsService(pg as any);
    await svc.update({});
    expect(pg.query.mock.calls[0][0]).toContain('SELECT');
  });
});
