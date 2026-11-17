import { Pool } from 'pg';
import { LEGACY_FRESH_FUTURE_SLACK_MS, LEGACY_FRESH_MIN_MS } from './after-reset';
import { ChatContextResetService } from './context-reset.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
// Своя схема на процесс: таблицу user_id в public заводят (IF NOT EXISTS) и
// чистят многие pg-спеки удаления — общая с ними таблица гонялась бы.
const SCHEMA = `context_reset_spec_${process.pid}`;

maybe('ChatContextResetService (pg)', () => {
  let admin: Pool;
  let pool: Pool;
  let svc: ChatContextResetService;

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 2, options: `-c search_path=${SCHEMA}` });
    // user_id — колонки признака удаления дословно из 001_core_schema.sql
    // (internal_id, state); reset сверяет по ним, удалён ли аккаунт.
    await pool.query(`
      CREATE TABLE user_id (
          state text,
          internal_id character varying NOT NULL UNIQUE
      )
    `);
    svc = new ChatContextResetService({ query: (sql: string, p?: any[]) => pool.query(sql, p) } as any);
    await svc.migrate();
    await svc.migrate(); // повторный старт не падает
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });
  beforeEach(async () => { await pool.query('TRUNCATE chat_context_resets, user_id'); });

  async function seedUser(internalId: string, state: string | null): Promise<void> {
    await pool.query('INSERT INTO user_id (internal_id, state) VALUES ($1, $2)', [internalId, state]);
  }

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

  it('точка раньше LEGACY_FRESH_MIN_MS отвергается и не пишется — та же граница, что у legacyFreshResetAt', async () => {
    await expect(svc.reset('u1', '10', new Date(0))).rejects.toThrow('invalid context reset time');
    await expect(svc.reset('u1', '10', new Date(LEGACY_FRESH_MIN_MS - 1))).rejects.toThrow('invalid context reset time');
    expect(await svc.get('u1', '10')).toBeNull();
    const at = await svc.reset('u1', '10', new Date(LEGACY_FRESH_MIN_MS));
    expect(at.getTime()).toBe(LEGACY_FRESH_MIN_MS);
  });

  it('удалённому аккаунту точка не пишется: access-токен живёт после удаления, строка осталась бы сиротой', async () => {
    await seedUser('u1', 'deleted');
    await expect(svc.reset('u1', '10')).rejects.toThrow('account deleted');
    // Явная метка старого клиента (applyLegacyFresh) — тот же отказ.
    await expect(svc.reset('u1', '10', new Date('2026-11-02T08:00:00Z'))).rejects.toThrow('account deleted');
    expect(await svc.get('u1', '10')).toBeNull();
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM chat_context_resets');
    expect(rows[0].n).toBe(0);
  });

  it('удалённому аккаунту прежняя точка не сдвигается', async () => {
    await svc.reset('u1', '10', new Date('2026-11-02T08:00:00Z'));
    await seedUser('u1', 'deleted');
    await expect(svc.reset('u1', '10')).rejects.toThrow('account deleted');
    expect((await svc.get('u1', '10'))?.toISOString()).toBe('2026-11-02T08:00:00.000Z');
  });

  it('живой аккаунт (state active или NULL у старых строк) — точка пишется, как раньше', async () => {
    await seedUser('u-active', 'active');
    await seedUser('u-legacy', null);
    const a = await svc.reset('u-active', '10', new Date('2026-11-02T08:00:00Z'));
    const b = await svc.reset('u-legacy', '10', new Date('2026-11-02T08:00:00Z'));
    expect(a.toISOString()).toBe('2026-11-02T08:00:00.000Z');
    expect(b.toISOString()).toBe('2026-11-02T08:00:00.000Z');
    // Удалён другой аккаунт — на чужую точку это не влияет.
    await seedUser('u-gone', 'deleted');
    expect((await svc.reset('u-active', '12')).getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it('таблица не принимает бесконечную точку: из-за GREATEST она стёрла бы память навсегда', async () => {
    await expect(
      pool.query(`INSERT INTO chat_context_resets (user_id, assistant_id, reset_at) VALUES ('u1', '10', 'infinity')`),
    ).rejects.toThrow(/check constraint/);
    expect(await svc.get('u1', '10')).toBeNull();
  });
});
