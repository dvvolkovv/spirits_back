import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { GUEST_TRIAL_MIGRATIONS, GuestTrialStore } from './guest-trial-store.service';
import { DEFAULT_GUEST_LIMITS } from './guest-trial.types';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('настройки пробы против живого Postgres', () => {
  let pool: Pool;
  let store: GuestTrialStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 4 });
    for (const f of GUEST_TRIAL_MIGRATIONS) {
      const sql = fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8');
      await pool.query(sql);
      await pool.query(sql); // повторный старт API — без ошибок
    }
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE guest_trial_settings');
    store = new GuestTrialStore({ query: (s: string, p?: any[]) => pool.query(s, p) } as any);
  });
  afterAll(async () => { await pool.end(); });

  it('без строк — «выкл» и лимиты по умолчанию', async () => {
    expect(await store.settings()).toEqual({ mode: 'off', limits: DEFAULT_GUEST_LIMITS });
  });

  it('режим и лимиты сохраняются, запись сбрасывает кэш', async () => {
    await store.settings();
    await store.setMode('preview');
    expect((await store.settings()).mode).toBe('preview');
    const r = await store.setLimits({ answersPerDay: 500, maxChars: 'x' });
    expect(r.ignored).toEqual(['maxChars=x']);
    expect((await store.settings()).limits).toMatchObject({ answersPerDay: 500, maxChars: DEFAULT_GUEST_LIMITS.maxChars });
  });
});
