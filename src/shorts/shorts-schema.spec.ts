/**
 * Накат миграции роликов — без базы. Живой повторный старт с открытой
 * пишущей транзакцией проверяет shorts.integration.spec.ts; здесь — то, что
 * живой прогон не видит: файл находится сервисом, катится при старте, его
 * форма не берёт лишних замков и не расходится с типами.
 */
import { ShortsSchemaService } from './shorts-schema.service';
import { ALLOWED_TRANSITIONS, SLOT_HOLDING_STATUSES } from './shorts.types';

async function appliedSql(): Promise<string> {
  const queries: string[] = [];
  const pg = { query: jest.fn(async (sql: string) => { queries.push(sql); return { rows: [] }; }) };
  await new ShortsSchemaService(pg as any).onModuleInit();
  const text = queries.find((q) => q.includes('CREATE TABLE short_video'));
  if (!text) throw new Error('миграция 001 не применена');
  return text.replace(/--[^\n]*/g, '');
}

describe('ShortsSchemaService', () => {
  it('катит 001 при старте модуля', async () => {
    expect(await appliedSql()).toContain('CREATE TABLE short_publication');
  });

  it('не роняет старт, если база ответила ошибкой', async () => {
    const pg = { query: jest.fn(async () => { throw new Error('boom'); }) };
    await expect(new ShortsSchemaService(pg as any).onModuleInit()).resolves.toBeUndefined();
  });
});

describe('текст 001_shorts.sql', () => {
  it('весь файл — один DO-блок под advisory-локом и lock_timeout', async () => {
    const sql = (await appliedSql()).trim();
    expect(sql.startsWith('DO $shorts$')).toBe(true);
    expect(sql).toContain("pg_advisory_xact_lock(hashtext('shorts/001'))");
    expect(sql).toContain("set_config('lock_timeout', '5s', true)");
  });

  it('каждый индекс — под IF to_regclass, а не голым CREATE INDEX IF NOT EXISTS', async () => {
    const sql = await appliedSql();
    const created = sql.match(/CREATE (UNIQUE )?INDEX/g) ?? [];
    const guarded = sql.match(/IF to_regclass\('public\.(uq|idx)_short_[a-z_]+'\) IS NULL THEN\s+CREATE (UNIQUE )?INDEX/g) ?? [];
    expect(created.length).toBeGreaterThan(0);
    expect(guarded.length).toBe(created.length);
    expect(sql).not.toMatch(/CREATE (UNIQUE )?INDEX IF NOT EXISTS/);
  });

  it('слот держат ровно SLOT_HOLDING_STATUSES', async () => {
    const m = (await appliedSql()).match(/uq_short_video_slot ON short_video \(slot_at\)\s+WHERE status IN \(([^)]*)\)/);
    const listed = (m?.[1].match(/'([a-z_]+)'/g) ?? []).map((s) => s.slice(1, -1));
    expect(listed.sort()).toEqual([...SLOT_HOLDING_STATUSES].sort());
  });

  it('статусы в CHECK совпадают с машиной состояний', async () => {
    const m = (await appliedSql()).match(/status\s+text NOT NULL DEFAULT 'idea' CHECK \(status IN \(([\s\S]*?)\)\)/);
    const listed = (m?.[1].match(/'([a-z_]+)'/g) ?? []).map((s) => s.slice(1, -1));
    expect(listed.sort()).toEqual(Object.keys(ALLOWED_TRANSITIONS).sort());
  });

  it('строка настроек — под IF NOT EXISTS: обычный SELECT не ждёт чужую правку', async () => {
    expect(await appliedSql()).toMatch(/IF NOT EXISTS \(SELECT 1 FROM short_settings WHERE id = 1\) THEN\s+INSERT INTO short_settings/);
  });
});
