import { Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { ReferralService } from './referral.service';

/**
 * K2 — DDL схемы referral на старте API и чужие блокировки.
 *
 * onModuleInit ReferralService на КАЖДОМ старте прогоняет DDL: расширение
 * телефонных колонок под alias удаления ('deleted:<uuid>', 44 символа — без
 * него referral.purge падает), два ADD COLUMN и migrations/001 (три колонки →
 * text). ALTER TABLE берёт ACCESS EXCLUSIVE ДО того, как выяснит, что делать
 * нечего: `ALTER COLUMN … TYPE text` по уже text-колонке и `ADD COLUMN IF NOT
 * EXISTS` по существующей колонке встают в очередь за любой открытой
 * транзакцией, читающей таблицу, а за ними — все новые запросы к таблице. Без
 * lock_timeout старт API висит, пока та транзакция не закончится.
 *
 * Что стережёт файл:
 *  (а) на актуальной схеме старт не просит ACCESS EXCLUSIVE ни у одной из
 *      пяти таблиц — проходит, пока чужая транзакция держит на них ACCESS
 *      SHARE (с ACCESS SHARE конфликтует только ACCESS EXCLUSIVE);
 *  (б) на исторической схеме (varchar(20), без двух колонок) старт её
 *      доводит до актуальной;
 *  (в) расширять надо, а таблицу держат — старт ждёт не дольше lock_timeout,
 *      пишет в logger.error, что это таймаут блокировки и что referral.purge
 *      будет падать до ручного ALTER, и идёт дальше; следующий старт без
 *      чужой блокировки доделывает.
 *
 * Как (а) стережётся без гонок. Пул сервиса открыт с сессионным lock_timeout
 * (TRIPWIRE_MS): любая попытка взять ACCESS EXCLUSIVE на удерживаемой таблице
 * ждёт не меньше этого и падает. Ошибка такой попытки доходит до
 * logger.error — кроме старой migrations/001, где её глотал `EXCEPTION WHEN
 * others THEN NULL`; поэтому вторая проверка — время: старт, хоть раз
 * вставший в очередь, длится не меньше TRIPWIRE_MS. Таймер в (в) — не
 * проверка, а предохранитель: без lock_timeout старт висел бы вечно.
 */

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

const TRIPWIRE_MS = 3_000;
const HANG_GUARD_MS = 30_000;

const TABLES = [
  'referral_leaders',
  'referral_referees',
  'referral_commissions',
  'referral_token_payouts',
  'referral_withdrawals',
];

/** Актуальная схема: что должно получиться после старта. */
const CURRENT: Record<string, string> = {
  'referral_leaders.user_phone': 'text',
  'referral_referees.referee_phone': 'text',
  'referral_commissions.referee_phone': 'text',
  'referral_token_payouts.user_phone': 'character varying(64)',
  'referral_withdrawals.user_phone': 'character varying(64)',
  'referral_referees.bonus_tokens': 'integer',
  'referral_leaders.payout_notified': 'boolean',
};

/**
 * Историческая форма: телефонные колонки varchar(20) (base/001_core_schema.sql
 * и прежний CREATE инлайновых таблиц), bonus_tokens/payout_notified ещё нет.
 * Плюс то, что читает migrations/002 (token_transactions и её enum).
 */
const HISTORICAL_SCHEMA = `
  CREATE TYPE transaction_type_enum AS ENUM
    ('purchase','consumed','bonus','refund','adjustment','coupon');
  CREATE TABLE token_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    transaction_type transaction_type_enum NOT NULL,
    amount bigint NOT NULL,
    balance_after bigint NOT NULL,
    description text,
    metadata jsonb,
    created_at timestamptz DEFAULT now()
  );
  CREATE TABLE referral_leaders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name varchar(255) NOT NULL,
    slug varchar(100) NOT NULL,
    user_phone varchar(20),
    is_active boolean DEFAULT true,
    created_at timestamptz DEFAULT now()
  );
  CREATE TABLE referral_referees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    referee_phone varchar(20) NOT NULL UNIQUE,
    leader_id uuid NOT NULL,
    registered_at timestamptz DEFAULT now()
  );
  CREATE TABLE referral_commissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    leader_id uuid NOT NULL,
    payment_id varchar(255),
    referee_phone varchar(20),
    commission_rub numeric(10,2),
    paid_out boolean DEFAULT false,
    created_at timestamptz DEFAULT now()
  );
  CREATE TABLE referral_token_payouts (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    leader_id uuid NOT NULL,
    user_phone varchar(20) NOT NULL,
    rub numeric(10,2) NOT NULL,
    tokens integer NOT NULL,
    rate integer NOT NULL,
    commission_ids uuid[] NOT NULL,
    created_at timestamptz DEFAULT now()
  );
  CREATE TABLE referral_withdrawals (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    leader_id uuid NOT NULL,
    user_phone varchar(20) NOT NULL,
    amount_rub numeric(10,2) NOT NULL,
    method varchar(20) NOT NULL,
    requisites text NOT NULL,
    status varchar(20) NOT NULL DEFAULT 'pending',
    commission_ids uuid[] NOT NULL,
    created_at timestamptz DEFAULT now(),
    processed_at timestamptz,
    processed_by varchar(40)
  );
`;

maybe('ReferralService.onModuleInit: DDL на старте и чужие блокировки (K2)', () => {
  jest.setTimeout(120_000);

  let admin: Pool;
  const pools: Pool[] = [];
  const schemas: string[] = [];
  let errors: jest.SpyInstance;

  beforeAll(() => {
    admin = new Pool({ connectionString: PG, max: 1 });
  });

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
    for (const s of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    await admin.end();
  });

  beforeEach(() => {
    errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  function poolFor(schema: string, sessionLockTimeoutMs?: number): Pool {
    const options = [`-c search_path=${schema}`];
    if (sessionLockTimeoutMs) options.push(`-c lock_timeout=${sessionLockTimeoutMs}`);
    const pool = new Pool({ connectionString: PG, max: 2, options: options.join(' ') });
    pools.push(pool);
    return pool;
  }

  async function historicalSchema(): Promise<string> {
    const schema = `referral_startup_ddl_spec_${process.pid}_${schemas.length + 1}`;
    schemas.push(schema);
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    await poolFor(schema).query(HISTORICAL_SCHEMA);
    return schema;
  }

  /** Старт сервиса — настоящий onModuleInit на пуле с нужным search_path. */
  function start(pool: Pool): Promise<void> {
    return new ReferralService({
      query: (sql: string, params?: any[]) => pool.query(sql, params),
      getClient: () => pool.connect(),
    } as any).onModuleInit();
  }

  async function columnTypes(pool: Pool): Promise<Record<string, string | null>> {
    const r = await pool.query(
      `SELECT c.col, format_type(a.atttypid, a.atttypmod) AS type
         FROM unnest($1::text[]) AS c(col)
         LEFT JOIN pg_attribute a
           ON a.attrelid = to_regclass(split_part(c.col, '.', 1))
          AND a.attname = split_part(c.col, '.', 2)
          AND NOT a.attisdropped`,
      [Object.keys(CURRENT)],
    );
    return Object.fromEntries(r.rows.map((row) => [row.col, row.type]));
  }

  /** Чужая открытая транзакция с ACCESS SHARE на таблицах — до release(). */
  async function holdAccessShare(schema: string, tables: string[]): Promise<() => Promise<void>> {
    const client = await poolFor(schema).connect();
    await client.query('BEGIN');
    await client.query(`LOCK TABLE ${tables.join(', ')} IN ACCESS SHARE MODE`);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    };
  }

  const errorLines = (): string[] => errors.mock.calls.map((c) => String(c[0]));

  it('(б) историческая схема: старт расширяет телефонные колонки и добавляет недостающие', async () => {
    const pool = poolFor(await historicalSchema());
    expect(await columnTypes(pool)).toMatchObject({
      'referral_withdrawals.user_phone': 'character varying(20)',
      'referral_leaders.user_phone': 'character varying(20)',
      'referral_referees.bonus_tokens': null,
    });

    await start(pool);

    expect(errorLines()).toEqual([]);
    expect(await columnTypes(pool)).toEqual(CURRENT);
  });

  it('(а) актуальная схема: старт не просит ACCESS EXCLUSIVE — проходит, пока чужая транзакция читает все пять таблиц', async () => {
    const schema = await historicalSchema();
    await start(poolFor(schema));
    expect(await columnTypes(poolFor(schema))).toEqual(CURRENT);
    errors.mockClear();

    const release = await holdAccessShare(schema, TABLES);
    let elapsed = Number.POSITIVE_INFINITY;
    try {
      const t0 = Date.now();
      await start(poolFor(schema, TRIPWIRE_MS));
      elapsed = Date.now() - t0;
    } finally {
      await release();
    }

    expect(errorLines()).toEqual([]);
    expect(elapsed).toBeLessThan(TRIPWIRE_MS);
    expect(await columnTypes(poolFor(schema))).toEqual(CURRENT);
  });

  it('(в) расширять надо, а таблицы держат: ждёт не дольше lock_timeout, объясняет в логе, идёт дальше; следующий старт доделывает', async () => {
    const schema = await historicalSchema();
    // Без сессионного lock_timeout — как на проде (0 = ждать вечно): ограничение
    // обязан поставить сам код старта.
    const pool = poolFor(schema);
    const release = await holdAccessShare(schema, ['referral_withdrawals', 'referral_commissions']);

    const startup = start(pool);
    let guard: NodeJS.Timeout | undefined;
    let outcome: 'done' | 'hung';
    try {
      outcome = await Promise.race([
        startup.then(() => 'done' as const),
        new Promise<'hung'>((resolve) => { guard = setTimeout(() => resolve('hung'), HANG_GUARD_MS); }),
      ]);
    } finally {
      if (guard) clearTimeout(guard);
      await release();
      await startup.catch(() => undefined);
    }
    expect(outcome).toBe('done');

    // Обе пропущенные таблицы остались узкими, логи объясняют почему и что сломано.
    const types = await columnTypes(pool);
    expect(types['referral_withdrawals.user_phone']).toBe('character varying(20)');
    expect(types['referral_commissions.referee_phone']).toBe('character varying(20)');
    // Не удерживаемая таблица расширена тем же стартом.
    expect(types['referral_token_payouts.user_phone']).toBe('character varying(64)');

    const lines = errorLines();
    const inline = lines.filter((l) => l.startsWith('referral_withdrawals.user_phone widen'));
    expect(inline).toHaveLength(1);
    expect(inline[0]).toMatch(/таймаут блокировки/);
    expect(inline[0]).toMatch(/referral\.purge/);
    expect(inline[0]).toContain('ALTER TABLE referral_withdrawals ALTER COLUMN user_phone TYPE varchar(64)');
    const file = lines.filter((l) => l.includes('001_user_id_to_text.sql') && /таймаут блокировки/.test(l));
    expect(file.length).toBeGreaterThanOrEqual(1);
    expect(file[0]).toMatch(/referral\.purge/);
    // Ничего, кроме этих двух шагов, не упало.
    expect(lines.filter((l) => !l.includes('referral_withdrawals.user_phone widen')
      && !l.includes('001_user_id_to_text.sql'))).toEqual([]);

    // Следующий старт без чужой блокировки доводит схему до актуальной.
    errors.mockClear();
    await start(pool);
    expect(errorLines()).toEqual([]);
    expect(await columnTypes(pool)).toEqual(CURRENT);
  });
});
