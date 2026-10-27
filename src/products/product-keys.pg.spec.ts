import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { MIGRATIONS } from './products.service';
import { ProvisioningService } from './provisioning.service';
import { HostsService } from './hosts.service';
import { LimitsService } from './limits.service';
import { RentService } from './rent.service';
import { SecretsService } from './secrets.service';
import { ProductActionsService } from './product-actions.service';
import { ProductKeysService } from './product-keys.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const KEY = '00112233445566778899aabbccddeeff0f1e2d3c4b5a69788796a5b4c3d2e1f0';

maybe('смена ключей целиком против живого Postgres', () => {
  let pool: Pool;
  let provisioning: ProvisioningService;
  let keys: ProductKeysService;
  let actions: ProductActionsService;
  const secrets = new SecretsService({ get: (k: string) => (k === 'PRODUCT_SECRETS_KEY' ? KEY : undefined) } as any);

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 8 });
    for (const f of MIGRATIONS) await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
    const pg = { query: (s: string, p?: any[]) => pool.query(s, p) };
    provisioning = new ProvisioningService(pg as any, secrets, new HostsService(pg as any), new LimitsService(pg as any), new RentService(pg as any));
    actions = new ProductActionsService(pg as any);
    keys = new ProductKeysService(pg as any, actions, secrets);
    (keys as any).checkBot = async () => ({ ok: true, id: 222, username: 'new_bot' });
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE products, product_provision_jobs, product_turns, product_actions, product_host_agent, product_hosts RESTART IDENTITY CASCADE');
    await pool.query(
      `INSERT INTO product_hosts (id, ssh_target, public_ip, domain_suffix, agent_token_hash, capacity, audience)
       VALUES ('clients', 'root@10.9.9.9', '10.9.9.9', 'c.example', 'x', 20, 'clients')`,
    );
  });
  afterAll(async () => {
    await pool.query('TRUNCATE products, product_provision_jobs, product_turns, product_actions, product_host_agent, product_hosts RESTART IDENTITY CASCADE');
    await pool.end();
  });

  async function bot(old: Record<string, string> = { BOT_TOKEN: '111111:TEST-old', OLD_KEY: 'o' }) {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO products (id, user_id, name, slug, kind, status, checkout_path, runner_token_hash, host_id, tg_bot_id, secrets_encrypted)
       VALUES ($1, 'u1', 'Бот', $2, 'bot', 'running', '/product', $3, 'clients', 111, $4)`,
      [id, `b-${id.slice(0, 8)}`, `h-${id}`, secrets.encrypt(old, id)],
    );
    return id;
  }

  it('карточка → задание с коробкой → агент получает новый набор → отчёт переносит ключи и метку бота', async () => {
    const p = await bot();
    const opened = await keys.open({ userId: 'u1', productId: p, channel: 'web', turn: null });
    expect(opened).toMatchObject({ ok: true, keyNames: ['BOT_TOKEN', 'OLD_KEY'] });
    const actionId = (opened as any).actionId;

    expect(await keys.complete({ userId: 'u1', actionId, set: { BOT_TOKEN: '222222:TEST-new', NEW_KEY: 'n' }, remove: ['OLD_KEY'], via: 'cabinet' }))
      .toEqual({ ok: true, queued: true });

    const job = await provisioning.claimJob('clients');
    expect(job).toMatchObject({ jobKind: 'rekey', secrets: { BOT_TOKEN: '222222:TEST-new', NEW_KEY: 'n' }, dropNames: ['OLD_KEY'] });

    await provisioning.completeJob(job!.jobId, { ok: true });

    const row = (await pool.query(`SELECT secrets_encrypted, tg_bot_id FROM products WHERE id = $1`, [p])).rows[0];
    expect(secrets.decrypt(row.secrets_encrypted, p)).toEqual({ BOT_TOKEN: '222222:TEST-new', NEW_KEY: 'n' });
    expect(Number(row.tg_bot_id)).toBe(222);
    const a = (await pool.query(`SELECT status, secrets_box, payload, result FROM product_actions WHERE id = $1`, [actionId])).rows[0];
    expect(a.status).toBe('done');
    expect(a.secrets_box).toBeNull();
    expect(JSON.stringify(a)).not.toMatch(/TEST-new|TEST-old/);
  });

  it('пока задание стоит, правка не ставится, а второе нажатие той же карточки — not_pending', async () => {
    const p = await bot();
    const { actionId } = (await keys.open({ userId: 'u1', productId: p, channel: 'web', turn: null })) as any;
    await keys.complete({ userId: 'u1', actionId, set: { NEW_KEY: 'n' }, remove: [], via: 'chat' });
    expect(await keys.complete({ userId: 'u1', actionId, set: { NEW_KEY: 'm' }, remove: [], via: 'chat' })).toMatchObject({ reason: 'not_pending' });
    const jobs = await pool.query(`SELECT count(*)::int AS n FROM product_provision_jobs WHERE product_id = $1 AND kind = 'rekey'`, [p]);
    expect(jobs.rows[0].n).toBe(1);
  });

  it('у продукта уже стоит задание — поправимо, коробка не записана', async () => {
    const p = await bot();
    await pool.query(`INSERT INTO product_provision_jobs (product_id, kind, status) VALUES ($1, 'domain', 'queued')`, [p]);
    const { actionId } = (await keys.open({ userId: 'u1', productId: p, channel: 'web', turn: null })) as any;
    expect(await keys.complete({ userId: 'u1', actionId, set: { NEW_KEY: 'n' }, remove: [], via: 'chat' })).toMatchObject({ reason: 'busy' });
    const a = (await pool.query(`SELECT status, secrets_box FROM product_actions WHERE id = $1`, [actionId])).rows[0];
    expect(a).toEqual({ status: 'pending', secrets_box: null });
  });

  it('старый ключ OWNER_TG_ID (имя занято позже) не мешает: агенту он не уходит ни в наборе, ни в снимаемых', async () => {
    const p = await bot({ BOT_TOKEN: '111111:TEST-old', OWNER_TG_ID: '42', OLD_KEY: 'o' });
    const opened = (await keys.open({ userId: 'u1', productId: p, channel: 'web', turn: null })) as any;
    expect(opened).toMatchObject({ ok: true, keyNames: ['BOT_TOKEN', 'OLD_KEY'] });

    expect(await keys.complete({ userId: 'u1', actionId: opened.actionId, set: { OLD_KEY: 'n' }, remove: [], via: 'chat' }))
      .toEqual({ ok: true, queued: true });

    const job = await provisioning.claimJob('clients');
    expect(job).toMatchObject({ jobKind: 'rekey', dropNames: [] });
    // toEqual, а не toMatchObject: лишний OWNER_TG_ID в наборе агент отверг бы.
    expect(job!.secrets).toEqual({ BOT_TOKEN: '111111:TEST-old', OLD_KEY: 'n' });

    await provisioning.completeJob(job!.jobId, { ok: true });
    const row = (await pool.query(`SELECT secrets_encrypted FROM products WHERE id = $1`, [p])).rows[0];
    expect(secrets.decrypt(row.secrets_encrypted, p)).toEqual({ BOT_TOKEN: '111111:TEST-old', OLD_KEY: 'n' });
  });
});
