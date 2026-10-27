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

const KEY = '00112233445566778899aabbccddeeff0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const secretsOf = () => new SecretsService({ get: (k: string) => (k === 'PRODUCT_SECRETS_KEY' ? KEY : undefined) } as any);

describe('OWNER_TG_ID — лучшим усилием', () => {
  it('таблицы привязок нет — задание всё равно выдаётся, без OWNER_TG_ID', async () => {
    const pg = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes("SET status = 'running'")) {
          return { rows: [{ job_id: 'j', job_kind: 'provision', product_id: 'p', user_id: 'u', slug: 's', name: 'Б', kind: 'bot', port: null, box: null, token_issued: true, custom_names: [], vhost_mode: 'proxy' }] };
        }
        if (sql.includes('tg_user_identities')) throw new Error('relation "tg_user_identities" does not exist');
        return { rows: [] };
      }),
    };
    const svc = new ProvisioningService(pg as any, secretsOf(), {} as any, {} as any, {} as any);
    const job = await svc.claimJob('clients');
    expect(job).toMatchObject({ jobId: 'j', jobKind: 'provision' });
    expect(job).not.toHaveProperty('ownerTgId');
    // Без этой проверки тест зеленел бы и без реализации: привязку обязаны
    // СПРОСИТЬ — и пережить отказ.
    expect(pg.query.mock.calls.some(([sql]) => String(sql).includes('tg_user_identities'))).toBe(true);
  });

  it('rekey: отказ чтения привязки — поля нет вовсе, не пустая строка', async () => {
    // Отказ чтения — не «привязки нет»: привязка, может, и есть. Пустая
    // строка (снять переменную) здесь снесла бы живой OWNER_TG_ID из-за
    // мигнувшей базы.
    const pg = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes("SET status = 'running'")) {
          return {
            rows: [{
              job_id: 'j', job_kind: 'rekey', product_id: 'p', user_id: 'u', slug: 's', name: 'Б',
              kind: 'bot', port: null, box: null, rekey_box: null, rekey_payload: {}, token_issued: false,
              custom_names: [], vhost_mode: 'proxy',
            }],
          };
        }
        if (sql.includes('tg_user_identities')) throw new Error('relation "tg_user_identities" does not exist');
        return { rows: [] };
      }),
    };
    const svc = new ProvisioningService(pg as any, secretsOf(), {} as any, {} as any, {} as any);
    const job = await svc.claimJob('clients');
    expect(job).toMatchObject({ jobId: 'j', jobKind: 'rekey' });
    expect(job).not.toHaveProperty('ownerTgId');
  });
});

describe('OWNER_TG_ID — привязки нет', () => {
  const ROW = {
    job_id: 'j', product_id: 'p', user_id: 'u', slug: 's', name: 'Б', kind: 'bot', port: null, box: null,
    rekey_box: null, rekey_payload: {}, custom_names: [], vhost_mode: 'proxy',
  };
  function harness(row: Record<string, unknown>, link: { rows: any[] }) {
    const pg = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes("SET status = 'running'")) return { rows: [{ ...ROW, ...row }] };
        if (sql.includes('tg_user_identities')) return link;
        return { rows: [] };
      }),
    };
    const svc = new ProvisioningService(pg as any, secretsOf(), {} as any, {} as any, {} as any);
    const asked = () => pg.query.mock.calls.some(([sql]) => String(sql).includes('tg_user_identities'));
    return { svc, asked };
  }

  it('rekey бота без привязки — пустая строка: агент снимает OWNER_TG_ID (Telegram отвязан)', async () => {
    // Отвязка в кабинете удаляет и строку tg_user_identities, поэтому «привязки
    // нет» теперь значит «владелец Telegram отвязал» — переменную снимаем.
    const { svc } = harness({ job_kind: 'rekey', token_issued: false }, { rows: [] });
    expect(await svc.claimJob('clients')).toMatchObject({ jobKind: 'rekey', ownerTgId: '' });
  });

  it('rekey бота с привязкой — её id', async () => {
    const { svc } = harness({ job_kind: 'rekey', token_issued: false }, { rows: [{ id: '111111111' }] });
    expect(await svc.claimJob('clients')).toMatchObject({ jobKind: 'rekey', ownerTgId: '111111111' });
  });

  it('заведение бота без привязки — поля нет вовсе: снимать нечего', async () => {
    const { svc, asked } = harness({ job_kind: 'provision', token_issued: true }, { rows: [] });
    const job = await svc.claimJob('clients');
    expect(job).toMatchObject({ jobKind: 'provision' });
    expect(job).not.toHaveProperty('ownerTgId');
    expect(asked()).toBe(true);
  });

  it.each(['rekey', 'provision'])('сайт (%s) — привязку не спрашивают, поля нет', async (jobKind) => {
    const { svc, asked } = harness({ job_kind: jobKind, kind: 'site', token_issued: jobKind === 'provision' }, { rows: [] });
    const job = await svc.claimJob('clients');
    expect(job).toMatchObject({ jobKind });
    expect(job).not.toHaveProperty('ownerTgId');
    expect(asked()).toBe(false);
  });
});

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('выдача rekey и purge против живого Postgres', () => {
  let pool: Pool;
  let svc: ProvisioningService;
  const secrets = secretsOf();

  async function product(o: { status: string; kind?: 'site' | 'bot'; userId?: string; archived?: boolean; purgeAfter?: string; purged?: boolean }) {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO products (id, user_id, name, slug, kind, status, checkout_path, runner_token_hash, host_id,
                             archived_at, purge_after, purged_at)
       VALUES ($1, $2, 'П', $3, $4, $5, '/product', $6, 'clients',
               CASE WHEN $7 THEN now() - interval '31 days' END, $8::timestamptz, CASE WHEN $9 THEN now() END)`,
      [id, o.userId ?? 'u1', `s-${id.slice(0, 8)}`, o.kind ?? 'bot', o.status, `h-${id}`, !!o.archived, o.purgeAfter ?? null, !!o.purged],
    );
    return id;
  }

  async function rekeyJob(
    productId: string,
    set: Record<string, string> | null,
    payload: any = {},
    actionStatus: string = 'working',
  ) {
    const a = await pool.query(
      `INSERT INTO product_actions (user_id, product_id, kind, status, channel, payload, secrets_box)
       VALUES ('u1', $1, 'keys', $4, 'web', $2::jsonb, $3) RETURNING id`,
      [productId, JSON.stringify(payload), set ? secrets.encrypt(set, productId) : null, actionStatus],
    );
    await pool.query(
      `INSERT INTO product_provision_jobs (product_id, kind, status, action_id) VALUES ($1, 'rekey', 'queued', $2)`,
      [productId, a.rows[0].id],
    );
    return a.rows[0].id as string;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 8 });
    for (const f of MIGRATIONS) await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
    // Своя копия таблицы привязок: она из модуля tg-bot (001_tg_bot_schema.sql),
    // а список MIGRATIONS здесь — только продукты. Форма — та же, что там.
    await pool.query(`CREATE TABLE IF NOT EXISTS tg_user_identities (
      linkeon_user_id text PRIMARY KEY, tg_user_id bigint UNIQUE NOT NULL,
      tg_username text, tg_first_name text, bound_at timestamptz NOT NULL DEFAULT now())`);
    const pg = { query: (s: string, p?: any[]) => pool.query(s, p) };
    svc = new ProvisioningService(pg as any, secrets, new HostsService(pg as any), new LimitsService(pg as any), new RentService(pg as any));
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE products, product_provision_jobs, product_turns, product_actions, product_host_agent, product_hosts RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE tg_user_identities CASCADE');
    await pool.query(
      `INSERT INTO product_hosts (id, ssh_target, public_ip, domain_suffix, agent_token_hash, capacity, audience)
       VALUES ('clients', 'root@10.9.9.9', '10.9.9.9', 'c.example', 'x', 20, 'clients')`,
    );
  });
  afterAll(async () => {
    await pool.query('TRUNCATE products, product_provision_jobs, product_turns, product_actions, product_host_agent, product_hosts RESTART IDENTITY CASCADE');
    // Своя таблица (чужого модуля, см. beforeAll) — чистим и её, а не только
    // то, что завела 001_products.sql: иначе сюда утекают строки, оставленные
    // этим файлом, на следующий прогон или на соседний спек-файл, который
    // тоже создаёт tg_user_identities IF NOT EXISTS и доверяет ей пустоту.
    await pool.query('TRUNCATE tg_user_identities CASCADE');
    await pool.end();
  });

  it('rekey работающему: новый набор расшифрован, снимаемые имена приехали, токена раннера нет', async () => {
    const p = await product({ status: 'running' });
    await rekeyJob(p, { BOT_TOKEN: '123456:TEST-new', NEW_KEY: 'n' }, { removedNames: ['OLD_KEY'] });
    const job = await svc.claimJob('clients');
    expect(job).toMatchObject({ productId: p, jobKind: 'rekey', secrets: { BOT_TOKEN: '123456:TEST-new', NEW_KEY: 'n' }, dropNames: ['OLD_KEY'] });
    expect(job).not.toHaveProperty('runnerToken');
  });

  it('rekey без коробки ключей не выдаётся вовсе — агент не снял бы ключи впустую', async () => {
    const p = await product({ status: 'running' });
    await rekeyJob(p, null);
    expect(await svc.claimJob('clients')).toBeNull();
  });

  it.each(['queued', 'running'])('rekey ждёт конца правки (ход в %s)', async (turnStatus) => {
    const p = await product({ status: 'running' });
    await rekeyJob(p, { BOT_TOKEN: '123456:TEST-new' });
    await pool.query(`INSERT INTO product_turns (product_id, user_id, channel, prompt, status) VALUES ($1, 'u1', 'web', 'п', $2)`, [p, turnStatus]);
    expect(await svc.claimJob('clients')).toBeNull();
    await pool.query(`UPDATE product_turns SET status = 'done' WHERE product_id = $1`, [p]);
    expect(await svc.claimJob('clients')).toMatchObject({ jobKind: 'rekey' });
  });

  it.each(['sleeping', 'blocked', 'provisioning', 'failed'])('rekey продукту в %s не выдаётся', async (status) => {
    const p = await product({ status });
    await rekeyJob(p, { BOT_TOKEN: '123456:TEST-new' });
    expect(await svc.claimJob('clients')).toBeNull();
  });

  it('rekey работающему в degraded выдаётся — та же ветка, что у running', async () => {
    const p = await product({ status: 'degraded' });
    await rekeyJob(p, { BOT_TOKEN: '123456:TEST-new' });
    expect(await svc.claimJob('clients')).toMatchObject({ productId: p, jobKind: 'rekey' });
  });

  it.each(['pending', 'done', 'expired', 'cancelled'])('карточка не working (%s) — rekey не выдаётся', async (actionStatus) => {
    const p = await product({ status: 'running' });
    await rekeyJob(p, { BOT_TOKEN: '123456:TEST-new' }, {}, actionStatus);
    expect(await svc.claimJob('clients')).toBeNull();
  });

  it('purge — удалённому после срока; до срока, стёртому и живому — нет', async () => {
    const due = await product({ status: 'archived', archived: true, purgeAfter: new Date(Date.now() - 60_000).toISOString() });
    const early = await product({ status: 'archived', archived: true, purgeAfter: new Date(Date.now() + 86_400_000).toISOString() });
    const gone = await product({ status: 'archived', archived: true, purgeAfter: new Date(Date.now() - 60_000).toISOString(), purged: true });
    const live = await product({ status: 'running' });
    for (const id of [early, gone, live, due]) {
      await pool.query(`INSERT INTO product_provision_jobs (product_id, kind, status) VALUES ($1, 'purge', 'queued')`, [id]);
    }
    const job = await svc.claimJob('clients');
    expect(job).toMatchObject({ productId: due, jobKind: 'purge', secrets: {} });
    expect(await svc.claimJob('clients')).toBeNull();
  });

  it('OWNER_TG_ID: бот владельца с привязкой — при заведении и при смене ключей; сайт и заведение без привязки — нет; смена ключей без привязки — пустая строка', async () => {
    await pool.query(`INSERT INTO tg_user_identities (linkeon_user_id, tg_user_id) VALUES ('u1', 777001)`);
    const bot = await product({ status: 'provisioning' });
    await pool.query(`INSERT INTO product_provision_jobs (product_id, status) VALUES ($1, 'queued')`, [bot]);
    expect(await svc.claimJob('clients')).toMatchObject({ jobKind: 'provision', ownerTgId: '777001' });

    const site = await product({ status: 'provisioning', kind: 'site' });
    await pool.query(`INSERT INTO product_provision_jobs (product_id, status) VALUES ($1, 'queued')`, [site]);
    expect(await svc.claimJob('clients')).not.toHaveProperty('ownerTgId');

    // Заведение бота БЕЗ привязки — поля нет вовсе (не пустая строка): у
    // заведения OWNER_TG_ID и так не бывает установлен, снимать нечего.
    const botNoLink = await product({ status: 'provisioning', userId: 'u2' });
    await pool.query(`INSERT INTO product_provision_jobs (product_id, status) VALUES ($1, 'queued')`, [botNoLink]);
    expect(await svc.claimJob('clients')).not.toHaveProperty('ownerTgId');

    // Смена ключей у владельца без привязки — пустая строка: отвязка в
    // кабинете удаляет и строку tg_user_identities, так что «привязки нет» —
    // это «Telegram отвязан», и агент снимает OWNER_TG_ID.
    const other = await product({ status: 'running', userId: 'u2' });
    await rekeyJob(other, { BOT_TOKEN: '123456:TEST-new' });
    expect(await svc.claimJob('clients')).toMatchObject({ jobKind: 'rekey', ownerTgId: '' });

    const mine = await product({ status: 'running' });
    await rekeyJob(mine, { BOT_TOKEN: '123456:TEST-new' });
    expect(await svc.claimJob('clients')).toMatchObject({ jobKind: 'rekey', ownerTgId: '777001' });
  });
});
