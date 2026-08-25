import { RoutineStore } from './routine-store.service';

const dbRow = (over: any = {}) => ({
  id: 'r1',
  user_id: 'u1',
  kind: 'energy_of_day',
  title: 'Энергия дня',
  assistant_id: '14',
  prompt: 'p',
  send_hour: 8,
  tz: 'Europe/Moscow',
  days: null,
  enabled: true,
  last_sent_date: null,
  ...over,
});

describe('RoutineStore: колонка kind', () => {
  it('list отдаёт kind наружу', async () => {
    const pg = { query: jest.fn().mockResolvedValue({ rows: [dbRow()] }) };
    const [row] = await new RoutineStore(pg as any).list('u1');

    expect(row.kind).toBe('energy_of_day');
  });

  it('map подставляет custom, если kind в строке пуст', async () => {
    const pg = { query: jest.fn().mockResolvedValue({ rows: [dbRow({ kind: null })] }) };
    const [row] = await new RoutineStore(pg as any).list('u1');

    expect(row.kind).toBe('custom');
  });

  it('create записывает переданный kind, а не хардкод custom', async () => {
    const pg = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ n: 0 }] })        // count
        .mockResolvedValueOnce({ rows: [dbRow()] }),        // INSERT ... RETURNING
    };
    await new RoutineStore(pg as any).create('u1', {
      title: 'Энергия дня',
      assistantId: '14',
      prompt: 'p',
      kind: 'energy_of_day',
    });

    const [sql, params] = pg.query.mock.calls[1];
    expect(sql).toMatch(/INSERT INTO routine_pushes/);
    expect(params).toContain('energy_of_day');
  });

  it('create по умолчанию остаётся custom', async () => {
    const pg = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ n: 0 }] })
        .mockResolvedValueOnce({ rows: [dbRow({ kind: 'custom' })] }),
    };
    await new RoutineStore(pg as any).create('u1', {
      title: 'Напоминание',
      assistantId: '14',
      prompt: 'p',
    });

    expect(pg.query.mock.calls[1][1]).toContain('custom');
  });
});
