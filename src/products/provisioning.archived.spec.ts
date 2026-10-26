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

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const KEY = '00112233445566778899aabbccddeeff0f1e2d3c4b5a69788796a5b4c3d2e1f0';

maybe('сон удалённого продукта против живого Postgres', () => {
  let pool: Pool;
  let svc: ProvisioningService;

  async function seed(o: { status: string; archived?: boolean; purged?: boolean; job: string }) {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO products (id, user_id, name, slug, kind, status, checkout_path, runner_token_hash, host_id, archived_at, purge_after, purged_at)
       VALUES ($1, 'u1', 'М', $2, 'site', $3, '/product', 'h', 'clients',
               CASE WHEN $4 THEN now() END, CASE WHEN $4 THEN now() + interval '30 days' END, CASE WHEN $5 THEN now() END)`,
      [id, `s-${id.slice(0, 8)}`, o.status, !!o.archived, !!o.purged],
    );
    const j = await pool.query(`INSERT INTO product_provision_jobs (product_id, kind, status) VALUES ($1, $2, 'queued') RETURNING id`, [id, o.job]);
    return { id, jobId: j.rows[0].id as string };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 8 });
    for (const f of MIGRATIONS) await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
    const pg = { query: (s: string, p?: any[]) => pool.query(s, p) };
    const secrets = new SecretsService({ get: (k: string) => (k === 'PRODUCT_SECRETS_KEY' ? KEY : undefined) } as any);
    // Настоящий RentService на том же пуле: этот файл promoteReady не зовёт,
    // но пятый аргумент теперь обязателен — живой сервис дешевле заглушки и
    // не рискует молча разойтись с реальным поведением.
    svc = new ProvisioningService(pg as any, secrets, new HostsService(pg as any), new LimitsService(pg as any), new RentService(pg as any));
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE products, product_provision_jobs, product_turns, product_host_agent, product_hosts RESTART IDENTITY CASCADE');
    await pool.query(
      `INSERT INTO product_hosts (id, ssh_target, public_ip, domain_suffix, agent_token_hash, capacity, audience)
       VALUES ('clients', 'root@10.9.9.9', '10.9.9.9', 'c.example', 'x', 20, 'clients')`,
    );
  });
  afterAll(async () => {
    await pool.query('TRUNCATE products, product_provision_jobs, product_turns, product_host_agent, product_hosts RESTART IDENTITY CASCADE');
    await pool.end();
  });

  it('сон удалённого выдаётся агенту, домен — на заглушку', async () => {
    const p = await seed({ status: 'archived', archived: true, job: 'sleep' });
    const job = await svc.claimJob('clients');
    expect(job).toMatchObject({ productId: p.id, jobKind: 'sleep', vhostMode: 'asleep' });
  });

  it('пробуждение удалённого не выдаётся', async () => {
    await seed({ status: 'archived', archived: true, job: 'wake' });
    expect(await svc.claimJob('clients')).toBeNull();
  });

  it('стёртому не выдаётся даже сон', async () => {
    await seed({ status: 'archived', archived: true, purged: true, job: 'sleep' });
    expect(await svc.claimJob('clients')).toBeNull();
  });

  it('сбой сна удалённого оставляет его удалённым, а не degraded', async () => {
    const p = await seed({ status: 'archived', archived: true, job: 'sleep' });
    const job = await svc.claimJob('clients');
    await svc.completeJob(job!.jobId, { ok: false, error: 'docker недоступен' });
    const r = await pool.query(`SELECT status FROM products WHERE id = $1`, [p.id]);
    expect(r.rows[0].status).toBe('archived');
  });
});
