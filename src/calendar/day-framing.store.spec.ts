import { DayFramingStore } from './day-framing.store';

// Мокаем PgService (тот же паттерн, что LinkeonTasksService/RoutineStore — DI через
// конструктор, единственный метод .query используется стором).
function makePg() {
  return { query: jest.fn() } as any;
}

describe('DayFramingStore', () => {
  it('onModuleInit применяет идемпотентную миграцию (CREATE TABLE IF NOT EXISTS day_framing)', async () => {
    const pg = makePg();
    pg.query.mockResolvedValueOnce({ rows: [] });
    const store = new DayFramingStore(pg);
    await store.onModuleInit();
    expect(pg.query.mock.calls[0][0]).toMatch(/CREATE TABLE IF NOT EXISTS day_framing/i);
  });

  it('get возвращает null, если строки нет', async () => {
    const pg = makePg();
    pg.query.mockResolvedValueOnce({ rows: [] });
    const store = new DayFramingStore(pg);
    expect(await store.get('u', '2026-08-06', 'morning')).toBeNull();
  });

  it('get возвращает { text, action, factsHash, dismissed }, когда строка есть', async () => {
    const pg = makePg();
    pg.query.mockResolvedValueOnce({
      rows: [{ text: 'Доброе утро', action: { kind: 'noop' }, factsHash: 'h1', dismissed: false }],
    });
    const store = new DayFramingStore(pg);
    const row = await store.get('u', '2026-08-06', 'morning');
    expect(row).toEqual({ text: 'Доброе утро', action: { kind: 'noop' }, factsHash: 'h1', dismissed: false });
  });

  it('upsert выполняет INSERT ... ON CONFLICT (user_id, day, kind)', async () => {
    const pg = makePg();
    pg.query.mockResolvedValueOnce({ rows: [] });
    const store = new DayFramingStore(pg);
    await store.upsert('u', '2026-08-06', 'morning', 'txt', null, 'h1');
    expect(pg.query.mock.calls[0][0]).toMatch(/INSERT INTO day_framing[\s\S]*ON CONFLICT/i);
    expect(pg.query.mock.calls[0][0]).toMatch(/ON CONFLICT\s*\(\s*user_id\s*,\s*day\s*,\s*kind\s*\)/i);
    expect(pg.query.mock.calls[0][1]).toEqual(['u', '2026-08-06', 'morning', 'txt', null, 'h1']);
  });

  it('upsert сериализует action в JSON, когда он передан', async () => {
    const pg = makePg();
    pg.query.mockResolvedValueOnce({ rows: [] });
    const store = new DayFramingStore(pg);
    await store.upsert('u', '2026-08-06', 'morning', 'txt', { kind: 'open_app' }, 'h1');
    expect(pg.query.mock.calls[0][1][4]).toBe(JSON.stringify({ kind: 'open_app' }));
  });

  it('markDismissed выставляет dismissed=true', async () => {
    const pg = makePg();
    pg.query.mockResolvedValueOnce({ rows: [] });
    const store = new DayFramingStore(pg);
    await store.markDismissed('u', '2026-08-06', 'evening');
    expect(pg.query.mock.calls[0][0]).toMatch(/UPDATE day_framing SET dismissed\s*=\s*true/i);
    expect(pg.query.mock.calls[0][1]).toEqual(['u', '2026-08-06', 'evening']);
  });
});
