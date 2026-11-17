import { Pool } from 'pg';
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
    expect((await svc.get('u1', '10'))?.getTime()).toBe(at.getTime());
  });

  it('точка только движется вперёд', async () => {
    await svc.reset('u1', '10', new Date('2026-11-17T08:00:00Z'));
    const kept = await svc.reset('u1', '10', new Date('2026-11-16T08:00:00Z'));
    expect(kept.toISOString()).toBe('2026-11-17T08:00:00.000Z');
    const moved = await svc.reset('u1', '10', new Date('2026-11-18T08:00:00Z'));
    expect(moved.toISOString()).toBe('2026-11-18T08:00:00.000Z');
  });

  it('пары независимы', async () => {
    await svc.reset('u1', '10', new Date('2026-11-17T08:00:00Z'));
    expect(await svc.get('u1', '12')).toBeNull();
    expect(await svc.get('u2', '10')).toBeNull();
  });
});
