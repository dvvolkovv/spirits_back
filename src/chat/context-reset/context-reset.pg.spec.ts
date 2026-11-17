import { Pool } from 'pg';
import { LEGACY_FRESH_FUTURE_SLACK_MS } from './after-reset';
import { ChatContextResetService } from './context-reset.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('ChatContextResetService (pg)', () => {
  let pool: Pool;
  let svc: ChatContextResetService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 2 });
    svc = new ChatContextResetService({ query: (sql: string, p?: any[]) => pool.query(sql, p) } as any);
    await svc.migrate();
    await svc.migrate(); // повторный старт не падает
  });
  afterAll(async () => {
    await pool?.query('DROP TABLE IF EXISTS chat_context_resets');
    await pool?.end();
  });
  beforeEach(async () => { await pool.query('TRUNCATE chat_context_resets'); });

  it('без точки — null', async () => {
    expect(await svc.get('u1', '10')).toBeNull();
  });

  it('reset без времени ставит точку «сейчас» по часам базы', async () => {
    const before = Date.now() - 5000;
    const at = await svc.reset('u1', '10');
    expect(at.getTime()).toBeGreaterThan(before);
    expect(at.getTime()).toBeLessThan(Date.now() + 5000);
    expect((await svc.get('u1', '10'))?.getTime()).toBe(at.getTime());
  });

  it('нажатие поверх старой точки ставит «сейчас»', async () => {
    await svc.reset('u1', '10', new Date('2026-11-16T08:00:00Z'));
    const before = Date.now() - 5000;
    const at = await svc.reset('u1', '10');
    expect(at.getTime()).toBeGreaterThan(before);
    expect(at.getTime()).toBeLessThan(Date.now() + 5000);
  });

  it('точка только движется вперёд', async () => {
    // Даты в прошлом: точку из будущего reset отвергает.
    await svc.reset('u1', '10', new Date('2026-11-02T08:00:00Z'));
    const kept = await svc.reset('u1', '10', new Date('2026-11-01T08:00:00Z'));
    expect(kept.toISOString()).toBe('2026-11-02T08:00:00.000Z');
    const moved = await svc.reset('u1', '10', new Date('2026-11-03T08:00:00Z'));
    expect(moved.toISOString()).toBe('2026-11-03T08:00:00.000Z');
  });

  it('пары независимы', async () => {
    await svc.reset('u1', '10', new Date('2026-11-02T08:00:00Z'));
    expect(await svc.get('u1', '12')).toBeNull();
    expect(await svc.get('u2', '10')).toBeNull();
  });

  it('assistantId числом из JSON и строкой из query — одна и та же пара', async () => {
    await svc.reset('u1', 10, new Date('2026-11-02T08:00:00Z'));
    expect((await svc.get('u1', '10'))?.toISOString()).toBe('2026-11-02T08:00:00.000Z');
    expect((await svc.get('u1', 10))?.toISOString()).toBe('2026-11-02T08:00:00.000Z');
  });

  it('точка из будущего дальше окна отвергается и не пишется: иначе память стёрлась бы навсегда', async () => {
    const future = new Date(Date.now() + LEGACY_FRESH_FUTURE_SLACK_MS + 60_000);
    await expect(svc.reset('u1', '10', future)).rejects.toThrow('invalid context reset time');
    expect(await svc.get('u1', '10')).toBeNull();
  });

  it('точка в пределах окна принимается как есть — так же, как legacyFreshResetAt', async () => {
    const near = new Date(Date.now() + 60_000);
    const at = await svc.reset('u1', '10', near);
    expect(at.getTime()).toBe(near.getTime());
  });

  it('Invalid Date отвергается понятной ошибкой и не пишется', async () => {
    await expect(svc.reset('u1', '10', new Date('nope'))).rejects.toThrow('invalid context reset time');
    expect(await svc.get('u1', '10')).toBeNull();
  });
});
