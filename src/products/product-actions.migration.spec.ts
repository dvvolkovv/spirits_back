import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { MIGRATIONS } from './products.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('009_product_actions против живого Postgres', () => {
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

  it('у продуктов есть колонки удаления, бота и первой правки', async () => {
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'products'
         AND column_name IN ('purge_after','purged_at','tg_bot_id','first_prompt','first_prompt_channel')`,
    );
    expect(r.rows.map((x: any) => x.column_name).sort()).toEqual(
      ['first_prompt', 'first_prompt_channel', 'purge_after', 'purged_at', 'tg_bot_id'],
    );
  });

  it('словари действия держит сама база', async () => {
    const bad = (kind: string, status: string, channel: string) =>
      pool.query(
        `INSERT INTO product_actions (user_id, kind, status, channel) VALUES ('u', $1, $2, $3)`,
        [kind, status, channel],
      );
    await expect(bad('create_bot', 'pending', 'web')).resolves.toBeDefined();
    await expect(bad('nuke', 'pending', 'web')).rejects.toThrow(/check/i);
    await expect(bad('delete', 'maybe', 'web')).rejects.toThrow(/check/i);
    await expect(bad('delete', 'pending', 'fax')).rejects.toThrow(/check/i);
  });
});
