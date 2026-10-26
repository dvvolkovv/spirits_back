import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { MIGRATIONS, ProductsService } from './products.service';

/**
 * Очередь 2: задание знает свою карточку (action_id), а словарь видов
 * задания знает rekey и purge. Без них смена ключей не связала бы задание
 * с шифротекстом новых ключей, а стирание не поставилось бы вовсе (CHECK).
 */
describe('010 обязательна: её колонку читает каждая выдача задания', () => {
  it('отказ 010 РОНЯЕТ старт, а не уходит в лог', async () => {
    const pg = {
      query: jest.fn(async (sql: string) => {
        if (String(sql).includes("products/010_rekey_purge")) throw new Error('не взлетело');
        return { rows: [] };
      }),
      getClient: jest.fn(async () => ({ query: jest.fn(async () => ({ rows: [] })), release: jest.fn() })),
    };
    await expect(new ProductsService(pg as any).onModuleInit()).rejects.toThrow(/010_rekey_purge\.sql/);
  });

  it('010 идёт сразу после 009 (ссылается на product_actions)', () => {
    expect(MIGRATIONS.indexOf('010_rekey_purge.sql')).toBe(MIGRATIONS.indexOf('009_product_actions.sql') + 1);
  });
});

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('010_rekey_purge против живого Postgres', () => {
  let pool: Pool;
  const apply = async () => {
    for (const f of MIGRATIONS) await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 4 });
    await apply();
  });
  afterAll(async () => {
    await pool.query('TRUNCATE products, product_provision_jobs, product_turns, product_actions RESTART IDENTITY CASCADE');
    await pool.end();
  });

  it('второй прогон всего списка проходит без ошибок', async () => {
    await expect(apply()).resolves.toBeUndefined();
  });

  it('внешний ключ на action_id — один, второй прогон его не дублирует', async () => {
    // ADD COLUMN IF NOT EXISTS на повторном прогоне — честный no-op (колонка
    // уже есть), но ссылка REFERENCES объявлена ПРИ добавлении колонки, а не
    // отдельным ADD CONSTRAINT — стоило проверить, что второй прогон не
    // прицепил бы вторую такую же ссылку молча.
    const fk = await pool.query(
      `SELECT count(*)::int AS n
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE c.conrelid = 'product_provision_jobs'::regclass
          AND c.contype = 'f'
          AND a.attname = 'action_id'`,
    );
    expect(fk.rows[0].n).toBe(1);
  });

  it('у задания есть action_id, и удаление карточки его обнуляет, а не удаляет задание', async () => {
    const p = await pool.query(
      `INSERT INTO products (user_id, name, slug, kind, status, checkout_path, runner_token_hash)
       VALUES ('u-mig', 'М', 'mig-010', 'bot', 'running', '/product', 'h-mig-010') RETURNING id`,
    );
    const a = await pool.query(
      `INSERT INTO product_actions (user_id, product_id, kind, status, channel) VALUES ('u-mig', $1, 'keys', 'working', 'web') RETURNING id`,
      [p.rows[0].id],
    );
    const j = await pool.query(
      `INSERT INTO product_provision_jobs (product_id, kind, status, action_id) VALUES ($1, 'rekey', 'queued', $2) RETURNING id`,
      [p.rows[0].id, a.rows[0].id],
    );
    await pool.query(`DELETE FROM product_actions WHERE id = $1`, [a.rows[0].id]);
    const left = await pool.query(`SELECT action_id FROM product_provision_jobs WHERE id = $1`, [j.rows[0].id]);
    expect(left.rows).toEqual([{ action_id: null }]);
  });

  it('словарь видов задания знает rekey и purge и по-прежнему держит чужое', async () => {
    const p = await pool.query(
      `INSERT INTO products (user_id, name, slug, kind, status, checkout_path, runner_token_hash)
       VALUES ('u-mig', 'М2', 'mig-010b', 'site', 'archived', '/product', 'h-mig-010b') RETURNING id`,
    );
    const ins = (kind: string) =>
      pool.query(`INSERT INTO product_provision_jobs (product_id, kind, status) VALUES ($1, $2, 'done')`, [p.rows[0].id, kind]);
    await expect(ins('rekey')).resolves.toBeDefined();
    await expect(ins('purge')).resolves.toBeDefined();
    await expect(ins('nuke')).rejects.toThrow(/check/i);
  });
});
