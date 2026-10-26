import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { MIGRATIONS } from './products.service';
import { ProductActionsService, REKEY_BLOCKED_SAY, REKEY_FAILED_SAY, REKEY_GONE_SAY, REKEY_UNKNOWN_SAY } from './product-actions.service';
import { JOB_KILLED_BY_BLOCK } from './block.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('подметальщик журнала и коробки ключей против живого Postgres', () => {
  let pool: Pool;
  let svc: ProductActionsService;

  async function product() {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO products (id, user_id, name, slug, kind, status, checkout_path, runner_token_hash)
       VALUES ($1, 'u1', 'П', $2, 'bot', 'running', '/product', $3)`,
      [id, `s-${id.slice(0, 8)}`, `h-${id}`],
    );
    return id;
  }
  async function keysCard(productId: string, o: { expired: boolean; job?: 'queued' | 'running' | 'failed'; started?: boolean; error?: string }) {
    const a = await pool.query(
      `INSERT INTO product_actions (user_id, product_id, kind, status, channel, secrets_box, expires_at)
       VALUES ('u1', $1, 'keys', 'working', 'web', '\\x01020304'::bytea,
               CASE WHEN $2 THEN now() - interval '20 minutes' ELSE now() + interval '20 minutes' END)
       RETURNING id`,
      [productId, o.expired],
    );
    if (o.job) {
      await pool.query(
        `INSERT INTO product_provision_jobs (product_id, kind, status, action_id, started_at, error)
         VALUES ($1, 'rekey', $2, $3, CASE WHEN $4 THEN now() END, $5)`,
        [productId, o.job, a.rows[0].id, !!o.started, o.error ?? null],
      );
    }
    return a.rows[0].id as string;
  }
  const card = async (id: string) => (await pool.query(`SELECT status, secrets_box, result FROM product_actions WHERE id = $1`, [id])).rows[0];

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 4 });
    for (const f of MIGRATIONS) await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
    svc = new ProductActionsService({ query: (s: string, p?: any[]) => pool.query(s, p) } as any);
  });
  beforeEach(() => pool.query('TRUNCATE products, product_provision_jobs, product_actions RESTART IDENTITY CASCADE'));
  afterAll(async () => {
    await pool.query('TRUNCATE products, product_provision_jobs, product_actions RESTART IDENTITY CASCADE');
    await pool.end();
  });

  it('карточка с живым заданием rekey не подметается даже после срока', async () => {
    const p = await product();
    const id = await keysCard(p, { expired: true, job: 'running' });
    await svc.sweepStuck();
    expect((await card(id)).status).toBe('working');
  });

  it('задание сняли до выдачи агенту (сборщик) — failed, «старые ключи», коробка стёрта', async () => {
    const p = await product();
    const id = await keysCard(p, { expired: false, job: 'failed', error: 'срок смены ключей истёк (10 мин)' });
    await svc.sweepStuck();
    const c = await card(id);
    expect(c.status).toBe('failed');
    expect(c.secrets_box).toBeNull();
    expect(c.result).toEqual({ error: REKEY_FAILED_SAY, reason: 'rekey_failed' });
  });

  it('задание сняли у агента в руках (started_at есть) — исход неизвестен: rekey_unknown', async () => {
    const p = await product();
    const id = await keysCard(p, { expired: false, job: 'failed', started: true, error: JOB_KILLED_BY_BLOCK });
    await svc.sweepStuck();
    expect((await card(id)).result).toEqual({ error: REKEY_UNKNOWN_SAY, reason: 'rekey_unknown' });
  });

  it('снято удалением до выдачи — «продукт удалён», без слов о старых ключах', async () => {
    const p = await product();
    const id = await keysCard(p, { expired: false, job: 'failed', error: 'снято удалением' });
    await svc.sweepStuck();
    expect((await card(id)).result).toEqual({ error: REKEY_GONE_SAY, reason: 'gone' });
  });

  it('снято блокировкой до выдачи — «остановлен администратором»', async () => {
    const p = await product();
    const id = await keysCard(p, { expired: false, job: 'failed', error: JOB_KILLED_BY_BLOCK });
    await svc.sweepStuck();
    expect((await card(id)).result).toEqual({ error: REKEY_BLOCKED_SAY, reason: 'blocked' });
  });

  it('прежнее поведение: working без задания после срока + 10 минут — failed с общим текстом', async () => {
    const p = await product();
    const id = await keysCard(p, { expired: true });
    await svc.sweepStuck();
    expect((await card(id)).result).toEqual({ error: 'Действие прервалось — попросите ассистента повторить' });
  });

  it('закрытая карточка с коробкой — коробка стирается подметальщиком', async () => {
    const p = await product();
    const id = await keysCard(p, { expired: false });
    await pool.query(`UPDATE product_actions SET status = 'done' WHERE id = $1`, [id]);
    await svc.sweepStuck();
    expect((await card(id)).secrets_box).toBeNull();
  });

  it('finish и release стирают коробку сами', async () => {
    const p = await product();
    const a = await keysCard(p, { expired: false });
    await svc.release(a, { error: 'поправьте' });
    expect((await card(a)).secrets_box).toBeNull();
    const b = await keysCard(p, { expired: false });
    await svc.finish(b, 'failed', { error: 'x' });
    expect((await card(b)).secrets_box).toBeNull();
  });
});
