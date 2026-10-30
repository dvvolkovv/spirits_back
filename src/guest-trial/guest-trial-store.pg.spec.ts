import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { GUEST_TRIAL_MIGRATIONS, GuestTrialStore } from './guest-trial-store.service';
import { DEFAULT_GUEST_LIMITS } from './guest-trial.types';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('настройки пробы против живого Postgres', () => {
  jest.setTimeout(15_000);
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
    expect(r.changed).toBe(true);
    expect((await store.settings()).limits).toMatchObject({ answersPerDay: 500, maxChars: DEFAULT_GUEST_LIMITS.maxChars });
  });

  it('в строке базы остаются только переопределения, повторные правки сливаются атомарно', async () => {
    await store.setLimits({ answersPerDay: 500 });
    let row = await pool.query(`SELECT value FROM guest_trial_settings WHERE key = 'limits'`);
    expect(row.rows[0].value).toEqual({ answersPerDay: 500 });

    await store.setLimits({ answersPerHour: 50 });
    row = await pool.query(`SELECT value FROM guest_trial_settings WHERE key = 'limits'`);
    expect(row.rows[0].value).toEqual({ answersPerDay: 500, answersPerHour: 50 });

    const garbage = await store.setLimits({ maxChars: 'мусор' });
    expect(garbage.changed).toBe(false);
    row = await pool.query(`SELECT value FROM guest_trial_settings WHERE key = 'limits'`);
    expect(row.rows[0].value).toEqual({ answersPerDay: 500, answersPerHour: 50 });
  });

  it('повторный старт не ждёт открытую запись в guest_trial_sessions', async () => {
    // Голый CREATE INDEX IF NOT EXISTS берёт ShareLock на таблицу и держит его
    // до конца транзакции файла — тогда каждый старт API ждал бы любую
    // открытую вставку пробы, а все вставки после — ждали бы его. Индексов на
    // guest_trial_sessions уже нет (см. 001_guest_trial.sql), но это свойство
    // файла стоит проверять явно, а не полагаться, что так вышло случайно.
    const sql = fs.readFileSync(path.join(__dirname, 'migrations', '001_guest_trial.sql'), 'utf8');
    const writer = await pool.connect();
    let timer: NodeJS.Timeout | undefined;
    try {
      await writer.query('BEGIN');
      await writer.query(
        `INSERT INTO guest_trial_sessions (token_hash, assistant_id, lang) VALUES ($1, 1, 'ru')`,
        [crypto.randomUUID()],
      );
      const second = pool.query(sql).then(() => 'done');
      const outcome = await Promise.race([
        second,
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve('blocked'), 8_000);
        }),
      ]);
      expect(outcome).toBe('done');
    } finally {
      clearTimeout(timer);
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release(true);
    }
  });
});
