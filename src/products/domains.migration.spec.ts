import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { MIGRATIONS } from './products.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

const WIPE = 'TRUNCATE products, product_provision_jobs, product_turns, product_host_agent, product_hosts RESTART IDENTITY CASCADE';

maybe('миграция 008: свой домен', () => {
  jest.setTimeout(60_000);
  let pool: Pool;

  const sqlOf = (f: string) => fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8');

  const mkHost = () =>
    pool.query(
      `INSERT INTO product_hosts (id, ssh_target, public_ip, domain_suffix, agent_token_hash, capacity, audience)
       VALUES ('own', 'root@139.59.210.42', '139.59.210.42', 'p.linkeon.io', 'probe-hash', 20, 'own')`,
    );

  const mkProduct = async (slug: string, user = '79030169187') => {
    const r = await pool.query(
      `INSERT INTO products (user_id, name, slug, kind, status, checkout_path, runner_token_hash, host_id)
       VALUES ($1, $2, $2, 'site', 'running', $3, $4, 'own') RETURNING id`,
      [user, slug, `/srv/${slug}`, `hash-${slug}`],
    );
    return r.rows[0].id as string;
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 4 });
    for (const f of MIGRATIONS) await pool.query(sqlOf(f));
    // Гард на чужую базу: TRUNCATE ниже адрес не разбирает.
    const n = await pool.query('SELECT count(*) FROM products');
    if (Number(n.rows[0].count) > 0) throw new Error('PROVISIONING_PG_URL указывает на НЕпустую базу');
  });
  afterAll(async () => {
    await pool?.query(WIPE);
    await pool?.end();
  });
  beforeEach(async () => {
    await pool.query(WIPE);
    await mkHost();
  });

  it('задание вида domain ставится', async () => {
    const id = await mkProduct('shop');
    await pool.query(`INSERT INTO product_provision_jobs (product_id, kind, status) VALUES ($1, 'domain', 'queued')`, [id]);
    const r = await pool.query(`SELECT kind FROM product_provision_jobs`);
    expect(r.rows[0].kind).toBe('domain');
  });

  // Главный сторож задачи. Модуль накатывает ВЕСЬ список при каждом старте;
  // 004 со старым словарём падала бы на существующем задании 'domain' — молча,
  // потому что applyMigration ловит отказ и едет дальше.
  it('повторная накатка всех миграций переживает существующее задание domain', async () => {
    const id = await mkProduct('shop');
    await pool.query(`INSERT INTO product_provision_jobs (product_id, kind, status) VALUES ($1, 'domain', 'done')`, [id]);
    for (const f of MIGRATIONS) {
      await expect(pool.query(sqlOf(f))).resolves.toBeDefined();
    }
  });

  it('один свой домен на продукт', async () => {
    const id = await mkProduct('shop');
    await pool.query(`INSERT INTO product_domains (product_id, domain, names, token) VALUES ($1, 'a.ru', '{a.ru,www.a.ru}', 'lk-1')`, [id]);
    await expect(
      pool.query(`INSERT INTO product_domains (product_id, domain, names, token) VALUES ($1, 'b.ru', '{b.ru}', 'lk-2')`, [id]),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('заявок в awaiting_dns на один домен может быть несколько', async () => {
    const a = await mkProduct('shop-a');
    const b = await mkProduct('shop-b', '70000000000');
    await pool.query(`INSERT INTO product_domains (product_id, domain, names, token) VALUES ($1, 'a.ru', '{a.ru}', 'lk-1')`, [a]);
    await expect(
      pool.query(`INSERT INTO product_domains (product_id, domain, names, token) VALUES ($1, 'a.ru', '{a.ru}', 'lk-2')`, [b]),
    ).resolves.toBeDefined();
  });

  it('занятый домен второй раз не занимается: индекс product_domains_occupied', async () => {
    const a = await mkProduct('shop-a');
    const b = await mkProduct('shop-b', '70000000000');
    await pool.query(`INSERT INTO product_domains (product_id, domain, names, token, status) VALUES ($1, 'a.ru', '{a.ru}', 'lk-1', 'active')`, [a]);
    await pool.query(`INSERT INTO product_domains (product_id, domain, names, token) VALUES ($1, 'a.ru', '{a.ru}', 'lk-2')`, [b]);
    await expect(
      pool.query(`UPDATE product_domains SET status = 'issuing' WHERE product_id = $1`, [b]),
    ).rejects.toMatchObject({ code: '23505', constraint: 'product_domains_occupied' });
  });

  it('словарь состояний закрыт', async () => {
    const id = await mkProduct('shop');
    await expect(
      pool.query(`INSERT INTO product_domains (product_id, domain, names, token, status) VALUES ($1, 'a.ru', '{a.ru}', 'lk', 'weird')`, [id]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('удаление продукта уносит его домен', async () => {
    const id = await mkProduct('shop');
    await pool.query(`INSERT INTO product_domains (product_id, domain, names, token) VALUES ($1, 'a.ru', '{a.ru}', 'lk')`, [id]);
    await pool.query(`DELETE FROM products WHERE id = $1`, [id]);
    const r = await pool.query(`SELECT count(*) FROM product_domains`);
    expect(Number(r.rows[0].count)).toBe(0);
  });
});
