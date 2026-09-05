import { AdminService } from './admin.service';

describe('getUserCalls', () => {
  const pg = { query: jest.fn() };
  const svc = new AdminService(pg as any);

  beforeEach(() => jest.resetAllMocks());

  it('отдаёт звонки с пометками и без расшифровок', async () => {
    pg.query.mockResolvedValue({
      rows: [
        {
          id: 'c-1', started_at: '2026-09-04T07:15:56Z', duration_sec: 153,
          status: 'completed', tokens_charged: 695, model: 'gpt-realtime',
          provider: 'linkeon', summary: 'Проверка связи',
          transcript: [{ ts: 1, role: 'assistant', text: 'Привет' }],
        },
        {
          id: 'c-2', started_at: '2026-09-03T10:00:00Z', duration_sec: null,
          status: 'interrupted', tokens_charged: 0, model: null,
          provider: 'linkeon', summary: null, transcript: null,
        },
      ],
    });

    const r = await svc.getUserCalls('79236230446');

    expect(r.calls).toHaveLength(2);
    expect(r.calls[0].flags).toContain('silent');
    expect(r.calls[0].user_turns).toBe(0);
    expect(r.calls[1].flags).toEqual(['interrupted']);
    // Расшифровку в списке не отдаём: она тяжёлая и нужна по клику.
    expect(r.calls[0]).not.toHaveProperty('transcript');
  });

  it('user_id уходит параметром, а не склейкой в SQL', async () => {
    pg.query.mockResolvedValue({ rows: [] });
    await svc.getUserCalls("' OR 1=1 --");
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).not.toContain('OR 1=1');
    expect(params).toContain("' OR 1=1 --");
  });
});

describe('getCallTranscript', () => {
  const pg = { query: jest.fn() };
  const svc = new AdminService(pg as any);

  beforeEach(() => jest.resetAllMocks());

  it('отдаёт реплики и саммари', async () => {
    pg.query.mockResolvedValue({
      rows: [{
        id: 'c-1', summary: 'О чём говорили', duration_sec: 100, status: 'completed',
        started_at: '2026-09-04T07:15:56Z',
        transcript: [{ ts: 1, role: 'user', text: 'Привет' }],
      }],
    });

    const r = await svc.getCallTranscript('c-1');

    expect(r?.summary).toBe('О чём говорили');
    expect(r?.transcript).toHaveLength(1);
  });

  it('нет такого звонка — null, чтобы контроллер отдал 404', async () => {
    pg.query.mockResolvedValue({ rows: [] });
    expect(await svc.getCallTranscript('нет-такого')).toBeNull();
  });

  it('мусор вместо расшифровки превращается в пустой массив, а не роняет', async () => {
    pg.query.mockResolvedValue({
      rows: [{ id: 'c-3', summary: null, transcript: 'битые данные' }],
    });
    expect((await svc.getCallTranscript('c-3'))?.transcript).toEqual([]);
  });
});
