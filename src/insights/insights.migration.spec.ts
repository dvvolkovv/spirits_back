import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { INSIGHTS_MIGRATIONS } from './insights-store.service';

const PG = process.env.INSIGHTS_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('миграция insights', () => {
  jest.setTimeout(60_000);
  let pool: Pool;
  const sqlOf = (f: string) => fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8');

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 2 });
    // Гард на чужую базу: ниже DROP TABLE.
    const app = await pool.query(`SELECT to_regclass('public.token_transactions') AS t`);
    if (app.rows[0].t) throw new Error('INSIGHTS_PG_URL указывает на базу приложения');
    await pool.query('DROP TABLE IF EXISTS insights_finding_weeks, insights_findings, insights_runs, insights_settings CASCADE');
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('катится дважды без ошибок — старт каждый раз', async () => {
    for (const f of INSIGHTS_MIGRATIONS) await pool.query(sqlOf(f));
    for (const f of INSIGHTS_MIGRATIONS) await pool.query(sqlOf(f));
    const t = await pool.query(
      `SELECT count(*)::int AS n FROM pg_tables WHERE tablename IN ('insights_runs','insights_findings','insights_finding_weeks','insights_settings')`,
    );
    expect(t.rows[0].n).toBe(4);
  });

  it('в таблицах нет колонок под пользователя и сессию', async () => {
    const c = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name LIKE 'insights_%' AND column_name ~ '(user|session|phone|email)'`,
    );
    expect(c.rows).toEqual([]);
  });
});
