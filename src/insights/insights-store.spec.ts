import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { INSIGHTS_MIGRATIONS, InsightsStore } from './insights-store.service';
import type { SynthFinding } from './insights.types';

const PG = process.env.INSIGHTS_PG_URL;
const maybe = PG ? describe : describe.skip;

const F = (over: Partial<SynthFinding> = {}): SynthFinding => ({
  priorId: null,
  type: 'confused',
  title: 'Путают два вида ботов',
  description: 'Идут за своим ботом во вкладку групповых ботов',
  proposal: 'Дать во вкладке ссылку на Продукты',
  people: 2,
  conversations: 3,
  assistants: ['Роман'],
  severity: 2,
  ...over,
});

maybe('хранилище находок', () => {
  jest.setTimeout(60_000);
  let pool: Pool;
  let store: InsightsStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 2 });
    const app = await pool.query(`SELECT to_regclass('public.token_transactions') AS t`);
    if (app.rows[0].t) throw new Error('INSIGHTS_PG_URL указывает на базу приложения');
    await pool.query('DROP TABLE IF EXISTS insights_finding_weeks, insights_findings, insights_runs, insights_settings CASCADE');
    for (const f of INSIGHTS_MIGRATIONS) await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
    store = new InsightsStore({ query: (sql: string, params?: unknown[]) => pool.query(sql, params as any[]) } as any);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE insights_finding_weeks, insights_findings, insights_runs, insights_settings');
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('находка прошлой недели продлевается, а не заводится заново', async () => {
    const [first] = await store.saveFindings('2026-10-12', [F()], []);
    const prior = await store.priorFindings('2026-10-19');
    expect(prior.map((p) => p.id)).toEqual([first.id]);
    const [second] = await store.saveFindings('2026-10-19', [F({ priorId: first.id, people: 3 })], prior);
    expect(second.id).toBe(first.id);
    expect(second.weeksSeen).toBe(2);
    expect(second.prevPeople).toBe(2);
  });

  it('повторный прогон недели не плодит находки и не теряет продлённую', async () => {
    const [old] = await store.saveFindings('2026-10-12', [F({ title: 'Старая находка' })], []);
    let prior = await store.priorFindings('2026-10-19');
    await store.saveFindings('2026-10-19', [F({ priorId: old.id }), F({ title: 'Новая находка' })], prior);

    expect(await store.weekHasResults('2026-10-19')).toBe(true);
    await store.resetWeek('2026-10-19');
    prior = await store.priorFindings('2026-10-19');
    // Продлённая первым прогоном снова видна как прошлая, новая этой недели — удалена.
    expect(prior.map((p) => p.id)).toEqual([old.id]);
    await store.saveFindings('2026-10-19', [F({ priorId: old.id }), F({ title: 'Новая находка' })], prior);

    const n = await pool.query(`SELECT count(*)::int AS n FROM insights_findings`);
    expect(n.rows[0].n).toBe(2);
  });

  it('находку в бэклоге сброс недели не трогает', async () => {
    const [f] = await store.saveFindings('2026-10-19', [F()], []);
    expect(await store.claimBacklog(f.id)).toBe(true);
    await store.resetWeek('2026-10-19');
    expect((await store.statuses([f.id])).get(f.id)).toBe('backlog');
  });

  it('нажатия идемпотентны: второй claim и reject не проходят', async () => {
    const [f] = await store.saveFindings('2026-10-19', [F()], []);
    expect(await store.reject(f.id, 2)).toBe(true);
    expect(await store.reject(f.id, 2)).toBe(false);
    expect(await store.claimBacklog(f.id)).toBe(false);
  });

  it('выключатель по умолчанию выключен', async () => {
    expect(await store.isEnabled()).toBe(false);
    await store.setEnabled(true);
    expect(await store.isEnabled()).toBe(true);
  });

  it('идущий прогон недели находится, законченный — нет', async () => {
    const id = await store.createRun('2026-10-19', true);
    expect(await store.activeRun('2026-10-19')).toBe(id);
    await store.failRun(id, 'x');
    expect(await store.activeRun('2026-10-19')).toBeNull();
  });

  it('находки сводки ищутся по её сообщению, в порядке кнопок', async () => {
    const [a, b] = await store.saveFindings('2026-10-19', [F({ title: 'Первая' }), F({ title: 'Вторая' })], []);
    const run = await store.createRun('2026-10-19', false);
    await store.setDigest(run, 42, 777, [b.id, a.id]);
    expect(await store.findingIdsForMessage(42, 777)).toEqual([b.id, a.id]);
    expect(await store.findingIdsForMessage(42, 778)).toBeNull();
  });

  it('оборванный «running» старше трёх часов закрывается', async () => {
    await pool.query(`INSERT INTO insights_runs (week_start, status, started_at) VALUES ('2026-10-19', 'running', now() - interval '4 hours')`);
    await pool.query(`INSERT INTO insights_runs (week_start, status, started_at) VALUES ('2026-10-19', 'running', now())`);
    expect(await store.reapStale()).toBe(1);
  });
});
