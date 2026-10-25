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

  // Минимальный набор колонок products — как в domains.migration.spec.ts и
  // соседних живых сьютах: checkout_path и runner_token_hash NOT NULL (001),
  // status без DEFAULT требует явного значения.
  const mkProduct = async (slug: string) => {
    const r = await pool.query(
      `INSERT INTO products (user_id, name, slug, kind, status, checkout_path, runner_token_hash)
       VALUES ('u', $1, $1, 'site', 'running', $2, $3) RETURNING id`,
      [slug, `/srv/${slug}`, `hash-${slug}`],
    );
    return r.rows[0].id as string;
  };

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

  it('словарь confirmed_via закрыт CHECK', async () => {
    const withConfirmedVia = (confirmedVia: string) =>
      pool.query(
        `INSERT INTO product_actions (user_id, kind, status, channel, confirmed_via) VALUES ('u', 'delete', 'pending', 'web', $1)`,
        [confirmedVia],
      );
    await expect(withConfirmedVia('cabinet')).resolves.toBeDefined();
    await expect(withConfirmedVia('email')).rejects.toThrow(/check/i);
  });

  it('удаление продукта не уносит его журнал — product_id отвязывается, строка остаётся', async () => {
    const productId = await mkProduct('pa-journal-survives');
    const inserted = await pool.query(
      `INSERT INTO product_actions (user_id, product_id, kind, status, channel) VALUES ('u', $1, 'delete', 'pending', 'web') RETURNING id`,
      [productId],
    );
    const actionId = inserted.rows[0].id as string;

    await pool.query('DELETE FROM products WHERE id = $1', [productId]);

    const r = await pool.query('SELECT product_id FROM product_actions WHERE id = $1', [actionId]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].product_id).toBeNull();
  });
});
