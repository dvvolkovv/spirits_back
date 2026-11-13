import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import type { DeletionExecution, DeletionJobRow } from '../account-deletion/account-deletion.types';
import { HostsService } from './hosts.service';
import { LimitsService } from './limits.service';
import { ProductAccountDeletionAdapter } from './product-account-deletion.adapter';
import { ProductAccountDeletionService } from './product-account-deletion.service';
import { ProductActionsService } from './product-actions.service';
import { ProductLifecycleService } from './product-lifecycle.service';
import { MIGRATIONS } from './products.service';
import { ProvisioningService } from './provisioning.service';
import { RentService } from './rent.service';
import { SecretsService } from './secrets.service';
import { TurnsService } from './turns.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const KEY = '00112233445566778899aabbccddeeff0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const DELETED_AT = new Date('2026-11-01T00:00:00.000Z');
const PRODUCT_ID = '22222222-2222-4222-8222-222222222222';
const NEIGHBOR_ID = '44444444-4444-4444-8444-444444444444';
const DELETION_ID = '11111111-1111-4111-8111-111111111111';
const OLD_DELETION_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_DELETION_ID = '66666666-6666-4666-8666-666666666666';
const sha = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

maybe('product account deletion против живого Postgres', () => {
  jest.setTimeout(30_000);

  let pool: Pool;
  let pg: {
    query: (sql: string, params?: any[]) => Promise<any>;
    getClient: () => Promise<any>;
  };
  let lifecycle: ProductLifecycleService;
  let turns: TurnsService;
  let misc: { checkTokenBalance: jest.Mock; deductTokens: jest.Mock };
  let service: ProductAccountDeletionService;
  let adapter: ProductAccountDeletionAdapter;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 8 });
    pg = {
      query: (sql: string, params?: any[]) => pool.query(sql, params),
      getClient: () => pool.connect(),
    };
    for (const file of MIGRATIONS) {
      await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', file), 'utf8'));
    }
    // Форма фикстуры — ТА ЖЕ, что в product-lifecycle.pg.spec.ts и
    // provisioning.integration.spec.ts (IF NOT EXISTS, nullable state): при
    // общем PROVISIONING_PG_URL порядок suite'ов не должен влиять на результат.
    await pool.query(`CREATE TABLE IF NOT EXISTS user_id (
      internal_id text PRIMARY KEY,
      state text,
      deleted_at timestamptz,
      deletion_id uuid
    )`);
    await pool.query(`CREATE TABLE ai_profiles_consolidated (
      id serial PRIMARY KEY,
      user_id text NOT NULL UNIQUE,
      isadmin boolean DEFAULT false,
      tokens bigint DEFAULT 1000000 NOT NULL
    )`);
    const count = await pool.query('SELECT count(*) FROM products');
    if (Number(count.rows[0].count) > 0) throw new Error('нужна свежая одноразовая база');
  });

  afterAll(async () => {
    await pool?.query('TRUNCATE products, product_provision_jobs, product_turns, product_actions, product_hosts, user_id, ai_profiles_consolidated RESTART IDENTITY CASCADE');
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE products, product_provision_jobs, product_turns, product_actions, product_host_agent, product_hosts, product_user_limits RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE user_id, ai_profiles_consolidated RESTART IDENTITY CASCADE');
    await pool.query(
      `INSERT INTO product_hosts (id, ssh_target, public_ip, domain_suffix, agent_token_hash, capacity, audience)
       VALUES ('host-shared', 'root@10.50.0.1', '10.50.0.1', 'c.linkeon.io', $1, 20, 'clients')`,
      [sha('host-shared-agent-fixture')],
    );

    const secrets = new SecretsService({ get: (key: string) => key === 'PRODUCT_SECRETS_KEY' ? KEY : undefined } as any);
    const provisioning = new ProvisioningService(
      pg as any,
      secrets,
      new HostsService(pg as any),
      new LimitsService(pg as any),
      new RentService(pg as any),
    );
    misc = {
      checkTokenBalance: jest.fn(async () => ({ ok: true })),
      deductTokens: jest.fn(async () => 0),
    };
    turns = new TurnsService(pg as any, misc as any);
    lifecycle = new ProductLifecycleService(
      pg as any,
      provisioning,
      new LimitsService(pg as any),
      turns,
      new ProductActionsService(pg as any),
      secrets,
    );
    service = new ProductAccountDeletionService(pg as any, lifecycle);
    adapter = new ProductAccountDeletionAdapter(service, new AccountDeletionRegistry());
  });

  async function seedAccount(
    userId: string,
    deletionId: string,
    state = 'deleted',
    deletedAt: Date | null = DELETED_AT,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO user_id (internal_id,state,deleted_at,deletion_id) VALUES ($1,$2,$3,$4)`,
      [userId, state, deletedAt, deletionId],
    );
    await pool.query(
      `INSERT INTO ai_profiles_consolidated (user_id,isadmin,tokens) VALUES ($1,false,1000000)`,
      [userId],
    );
  }

  async function seedProduct(o: {
    id?: string;
    userId: string;
    status: string;
    slug: string;
    hostId?: string | null;
    archivedAt?: Date | null;
    purgeAfter?: Date | null;
    purgedAt?: Date | null;
    blockReason?: string | null;
    firstPrompt?: string | null;
  }): Promise<string> {
    const id = o.id ?? crypto.randomUUID();
    await pool.query(
      `INSERT INTO products (
         id,user_id,name,slug,kind,status,checkout_path,runner_token_hash,host_id,
         archived_at,purge_after,purged_at,block_reason,first_prompt,first_prompt_channel
       ) VALUES ($1,$2,$3,$4,'site',$5,'/product',$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        id,
        o.userId,
        `Product ${o.slug}`,
        o.slug,
        o.status,
        sha(`runner-${id}`),
        o.hostId === undefined ? 'host-shared' : o.hostId,
        o.archivedAt ?? null,
        o.purgeAfter ?? null,
        o.purgedAt ?? null,
        o.blockReason ?? null,
        o.firstPrompt ?? null,
        o.firstPrompt == null ? null : 'web',
      ],
    );
    return id;
  }

  async function seedJob(
    productId: string,
    status = 'running',
    kind = 'provision',
  ): Promise<string> {
    const result = await pool.query(
      `INSERT INTO product_provision_jobs (product_id,kind,status) VALUES ($1,$2,$3) RETURNING id`,
      [productId, kind, status],
    );
    return result.rows[0].id;
  }

  async function seedTurn(productId: string, userId: string, status = 'running'): Promise<string> {
    const result = await pool.query(
      `INSERT INTO product_turns (product_id,user_id,channel,prompt,status)
       VALUES ($1,$2,'web','technical fixture',$3) RETURNING id`,
      [productId, userId, status],
    );
    return result.rows[0].id;
  }

  function stopJob(overrides: Partial<DeletionJobRow> = {}): DeletionJobRow {
    return {
      id: crypto.randomUUID(),
      deletionId: DELETION_ID,
      userId: 'u-deleted',
      resourceType: 'product.stop',
      resourceKey: PRODUCT_ID,
      phase: 'immediate',
      payload: { productId: PRODUCT_ID, slug: 'slug-1', hostId: 'host-shared' },
      status: 'running',
      attempts: 1,
      nextAttemptAt: DELETED_AT,
      leaseUntil: new Date(Date.now() + 300_000),
      lastErrorKind: null,
      ...overrides,
    };
  }

  function execution(): DeletionExecution {
    return {
      db: pg,
      // Старый generation проверяется отдельно и на SQL service, не только на
      // coordinator assertCurrent. Поэтому здесь guard не подменяет предикаты.
      assertCurrent: async () => undefined,
    };
  }

  async function latestSleep(productId = PRODUCT_ID): Promise<any> {
    const result = await pool.query(
      `SELECT id,status,error FROM product_provision_jobs
       WHERE product_id=$1 AND kind='sleep' ORDER BY created_at DESC,id DESC LIMIT 1`,
      [productId],
    );
    return result.rows[0];
  }

  it.each(['provisioning', 'running'])(
    '%s: forced archive убивает job/turn, не признаёт sleep до done и не трогает соседа',
    async (status) => {
      await seedAccount('u-deleted', DELETION_ID);
      await seedAccount('u-other', OTHER_DELETION_ID, 'active', null);
      await seedProduct({
        id: PRODUCT_ID,
        userId: 'u-deleted',
        status,
        slug: 'slug-1',
        firstPrompt: 'first draft',
      });
      await seedProduct({ id: NEIGHBOR_ID, userId: 'u-other', status: 'running', slug: 'slug-2' });
      const provisionId = await seedJob(PRODUCT_ID, 'running', 'provision');
      const turnId = await seedTurn(PRODUCT_ID, 'u-deleted', 'running');
      const neighborJobId = await seedJob(NEIGHBOR_ID, 'running', 'provision');
      const neighborTurnId = await seedTurn(NEIGHBOR_ID, 'u-other', 'running');
      const hostBefore = (await pool.query(`SELECT * FROM product_hosts WHERE id='host-shared'`)).rows[0];
      const value = stopJob();
      const payload = JSON.parse(JSON.stringify(value.payload));

      await expect(adapter.execute(value, execution())).rejects.toMatchObject({ kind: 'external_unknown' });

      const own = await pool.query(
        `SELECT status,error,finished_at IS NOT NULL AS finished FROM product_provision_jobs WHERE id=$1`,
        [provisionId],
      );
      expect(own.rows[0]).toMatchObject({ status: 'failed', error: 'account_deleted', finished: true });
      const turn = await pool.query(
        `SELECT status,error,finished_at IS NOT NULL AS finished FROM product_turns WHERE id=$1`,
        [turnId],
      );
      expect(turn.rows[0]).toMatchObject({ status: 'failed', error: 'account_deleted', finished: true });
      const product = await pool.query(
        `SELECT status,slug,host_id,purge_after,first_prompt,first_prompt_channel,archived_at
         FROM products WHERE id=$1`,
        [PRODUCT_ID],
      );
      expect(product.rows[0]).toMatchObject({
        status: 'archived',
        slug: 'slug-1',
        host_id: 'host-shared',
        first_prompt: null,
        first_prompt_channel: null,
      });
      expect(product.rows[0].archived_at).toBeInstanceOf(Date);
      expect(product.rows[0].purge_after).toEqual(new Date(DELETED_AT.getTime() + 30 * 86_400_000));
      expect((await latestSleep()).status).toBe('queued');
      expect(value.payload).toEqual(payload);

      const sleepId = (await latestSleep()).id;
      for (const sleepStatus of ['queued', 'running', 'failed']) {
        await pool.query(`UPDATE product_provision_jobs SET status=$2,finished_at=NULL WHERE id=$1`, [sleepId, sleepStatus]);
        await expect(adapter.execute(value, execution())).rejects.toMatchObject({ kind: 'external_unknown' });
        expect((await latestSleep()).id).toBe(sleepId);
        expect((await pool.query(`SELECT count(*)::int AS n FROM product_provision_jobs WHERE product_id=$1 AND kind='sleep'`, [PRODUCT_ID])).rows[0].n).toBe(1);
      }

      // Это только строка результата host pull-модели, без HostApi/SSH/runner.
      await pool.query(`UPDATE product_provision_jobs SET status='done',finished_at=now() WHERE id=$1`, [sleepId]);
      await expect(adapter.execute(value, execution())).resolves.toBeUndefined();
      await expect(adapter.execute(value, execution())).resolves.toBeUndefined();
      expect((await latestSleep()).id).toBe(sleepId);
      expect((await pool.query(`SELECT count(*)::int AS n FROM product_provision_jobs WHERE product_id=$1 AND kind='sleep'`, [PRODUCT_ID])).rows[0].n).toBe(1);

      const neighbor = await pool.query(
        `SELECT p.status,p.slug,p.host_id,j.status AS job_status,j.error AS job_error,t.status AS turn_status,t.error AS turn_error
         FROM products p
         JOIN product_provision_jobs j ON j.id=$2
         JOIN product_turns t ON t.id=$3
         WHERE p.id=$1`,
        [NEIGHBOR_ID, neighborJobId, neighborTurnId],
      );
      expect(neighbor.rows[0]).toEqual({
        status: 'running',
        slug: 'slug-2',
        host_id: 'host-shared',
        job_status: 'running',
        job_error: null,
        turn_status: 'running',
        turn_error: null,
      });
      expect((await pool.query(`SELECT * FROM product_hosts WHERE id='host-shared'`)).rows[0]).toEqual(hostBefore);
    },
  );

  it('blocked архивируется без confirmation card, slug/host/block_reason сохраняются', async () => {
    await seedAccount('u-deleted', DELETION_ID);
    await seedProduct({
      id: PRODUCT_ID,
      userId: 'u-deleted',
      status: 'blocked',
      slug: 'slug-1',
      blockReason: 'administrative block',
    });

    await expect(adapter.execute(stopJob(), execution())).rejects.toMatchObject({ kind: 'external_unknown' });

    expect((await pool.query(`SELECT status,slug,host_id,block_reason FROM products WHERE id=$1`, [PRODUCT_ID])).rows[0]).toEqual({
      status: 'archived',
      slug: 'slug-1',
      host_id: 'host-shared',
      block_reason: 'administrative block',
    });
    expect((await latestSleep()).status).toBe('queued');
    expect((await pool.query('SELECT count(*)::int AS n FROM product_actions')).rows[0].n).toBe(0);
  });

  it('потерянный после CTE sleep восстанавливается через queueSleepForDeleted, но остаётся retry', async () => {
    await seedAccount('u-deleted', DELETION_ID);
    await seedProduct({ id: PRODUCT_ID, userId: 'u-deleted', status: 'running', slug: 'slug-1' });
    const baseQuery = pg.query;
    jest.spyOn(pg, 'query').mockImplementation(async (sql: string, params?: any[]) => {
      const result = await baseQuery(sql, params);
      if (sql.includes('WITH target AS') && sql.includes('account_deleted')) {
        // Моделируем потерю подтверждения вставки между CTE и чтением service.
        await pool.query(`DELETE FROM product_provision_jobs WHERE product_id=$1 AND kind='sleep'`, [PRODUCT_ID]);
      }
      return result;
    });
    const repair = jest.spyOn(lifecycle, 'queueSleepForDeleted');

    await expect(adapter.execute(stopJob(), execution())).rejects.toMatchObject({ kind: 'external_unknown' });

    expect(repair).toHaveBeenCalledWith(PRODUCT_ID);
    expect((await latestSleep()).status).toBe('queued');
    expect((await pool.query(`SELECT count(*)::int AS n FROM product_provision_jobs WHERE product_id=$1 AND kind='sleep'`, [PRODUCT_ID])).rows[0].n).toBe(1);
  });

  it('restore и turn enqueue удалённого аккаунта no-op; active enqueue сохраняет прежнее поведение', async () => {
    await seedAccount('u-deleted', DELETION_ID);
    await seedProduct({
      id: PRODUCT_ID,
      userId: 'u-deleted',
      status: 'archived',
      slug: 'slug-1',
      archivedAt: DELETED_AT,
      purgeAfter: new Date(DELETED_AT.getTime() + 30 * 86_400_000),
    });
    const sleepId = await seedJob(PRODUCT_ID, 'queued', 'sleep');

    await expect(lifecycle.restore({ userId: 'u-deleted', productId: PRODUCT_ID, channel: 'web' }))
      .resolves.toMatchObject({ ok: false, reason: 'not_found' });
    expect((await pool.query(`SELECT status,archived_at FROM products WHERE id=$1`, [PRODUCT_ID])).rows[0].status).toBe('archived');
    expect((await pool.query(`SELECT status FROM product_provision_jobs WHERE id=$1`, [sleepId])).rows[0].status).toBe('queued');
    expect((await pool.query('SELECT count(*)::int AS n FROM product_actions')).rows[0].n).toBe(0);

    await seedProduct({ id: NEIGHBOR_ID, userId: 'u-deleted', status: 'running', slug: 'deleted-running' });
    await expect(turns.enqueue({ productId: NEIGHBOR_ID, userId: 'u-deleted', channel: 'web', prompt: 'do not run' }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect((await pool.query(`SELECT count(*)::int AS n FROM product_turns WHERE product_id=$1`, [NEIGHBOR_ID])).rows[0].n).toBe(0);
    expect(misc.checkTokenBalance).not.toHaveBeenCalled();

    await seedAccount('u-active', OTHER_DELETION_ID, 'active', null);
    await seedProduct({ userId: 'u-active', status: 'running', slug: 'active-running' });
    const active = (await pool.query(`SELECT id FROM products WHERE slug='active-running'`)).rows[0].id;
    await expect(turns.enqueue({ productId: active, userId: 'u-active', channel: 'web', prompt: 'normal turn' }))
      .resolves.toMatchObject({ status: 'queued' });
    expect((await pool.query(`SELECT count(*)::int AS n FROM product_turns WHERE product_id=$1`, [active])).rows[0].n).toBe(1);
  });

  it('старый deletion generation ничего не архивирует, не убивает и не чинит', async () => {
    await seedAccount('u-deleted', DELETION_ID);
    await seedProduct({ id: PRODUCT_ID, userId: 'u-deleted', status: 'running', slug: 'slug-1' });
    const jobId = await seedJob(PRODUCT_ID, 'running', 'provision');
    const turnId = await seedTurn(PRODUCT_ID, 'u-deleted', 'running');
    const repair = jest.spyOn(lifecycle, 'queueSleepForDeleted');

    await expect(adapter.execute(stopJob({ deletionId: OLD_DELETION_ID }), execution()))
      .rejects.toMatchObject({ kind: 'external_unknown' });

    expect((await pool.query(`SELECT status FROM products WHERE id=$1`, [PRODUCT_ID])).rows[0].status).toBe('running');
    expect((await pool.query(`SELECT status,error FROM product_provision_jobs WHERE id=$1`, [jobId])).rows[0]).toEqual({ status: 'running', error: null });
    expect((await pool.query(`SELECT status,error FROM product_turns WHERE id=$1`, [turnId])).rows[0]).toEqual({ status: 'running', error: null });
    expect(await latestSleep()).toBeUndefined();
    expect(repair).not.toHaveBeenCalled();
  });

  it('I-1: продукт уже стёрт штатным purge — подтверждённая остановка, а не вечный retry', async () => {
    await seedAccount('u-deleted', DELETION_ID);
    const purgedAt = new Date('2026-11-10T00:00:00.000Z');
    await seedProduct({
      id: PRODUCT_ID,
      userId: 'u-deleted',
      status: 'archived',
      slug: 'slug-1',
      archivedAt: DELETED_AT,
      purgeAfter: DELETED_AT,
      purgedAt,
    });
    const value = stopJob();
    const payload = JSON.parse(JSON.stringify(value.payload));

    // purged — более сильная остановка, чем sleep: контейнера и данных уже
    // нет. External_unknown здесь означал бы вечный retry одного product.stop,
    // который блокирует ВСЁ удаление аккаунта.
    await expect(adapter.execute(value, execution())).resolves.toBeUndefined();

    expect(value.payload).toEqual(payload);
    // Job не висит: новая работа и новый sleep не ставятся, строка не правится.
    expect(await latestSleep()).toBeUndefined();
    expect((await pool.query('SELECT count(*)::int AS n FROM product_provision_jobs')).rows[0].n).toBe(0);
    const product = await pool.query(
      `SELECT status,archived_at,purged_at,purge_after FROM products WHERE id=$1`,
      [PRODUCT_ID],
    );
    expect(product.rows[0]).toMatchObject({
      status: 'archived',
      archived_at: DELETED_AT,
      purged_at: purgedAt,
      purge_after: DELETED_AT,
    });
  });

  it('I-1: строка продукта отсутствует — та же подтверждённая остановка', async () => {
    await seedAccount('u-deleted', DELETION_ID);

    await expect(adapter.execute(stopJob(), execution())).resolves.toBeUndefined();
    expect(await latestSleep()).toBeUndefined();
  });

  it('I-2: продукт без хоста — sleep остаётся queued, retry сохраняется, error-сигнал разовый', async () => {
    await seedAccount('u-deleted', DELETION_ID);
    await seedProduct({ id: PRODUCT_ID, userId: 'u-deleted', status: 'running', slug: 'slug-1', hostId: null });
    // До фикса у сервиса не было logger — fallback держит тест красным по
    // существу (0 вызовов), а не падением spyOn.
    const errorSpy = jest
      .spyOn((service as any).logger ?? { error: () => undefined }, 'error')
      .mockImplementation(() => undefined);

    await expect(adapter.execute(stopJob(), execution())).rejects.toMatchObject({ kind: 'external_unknown' });

    // claimJob выдаёт sleep строго по p.host_id — queued-sleep не заберёт никто.
    expect((await latestSleep()).status).toBe('queued');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = String(errorSpy.mock.calls[0][0]);
    expect(message).toContain('no host');
    expect(message).toContain(PRODUCT_ID);
    // Никакого userId/PII в тексте.
    expect(message).not.toContain('u-deleted');

    // Повторный attempt идемпотентен: тот же retry, дубля error-лога нет.
    await expect(adapter.execute(stopJob(), execution())).rejects.toMatchObject({ kind: 'external_unknown' });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect((await latestSleep()).status).toBe('queued');
    expect((await pool.query(`SELECT count(*)::int AS n FROM product_provision_jobs WHERE product_id=$1 AND kind='sleep'`, [PRODUCT_ID])).rows[0].n).toBe(1);
  });

  it('M-6: уже архивный продукт с подтверждённым сном — дата архива сохраняется, purge_after нового поколения', async () => {
    await seedAccount('u-deleted', DELETION_ID);
    const archivedAt = new Date('2026-10-01T00:00:00.000Z');
    await seedProduct({
      id: PRODUCT_ID,
      userId: 'u-deleted',
      status: 'archived',
      slug: 'slug-1',
      archivedAt,
      purgeAfter: new Date('2026-10-31T00:00:00.000Z'), // срок СТАРОГО поколения
    });
    const sleepId = await seedJob(PRODUCT_ID, 'done', 'sleep');
    await pool.query(
      `UPDATE product_provision_jobs SET created_at=$2,started_at=$2,finished_at=$2 WHERE id=$1`,
      [sleepId, new Date('2026-10-01T01:00:00.000Z')],
    );

    await expect(adapter.execute(stopJob(), execution())).resolves.toBeUndefined();

    const product = await pool.query(`SELECT status,archived_at,purge_after FROM products WHERE id=$1`, [PRODUCT_ID]);
    expect(product.rows[0].status).toBe('archived');
    // COALESCE(archived_at,now()) не затирает старую дату архива...
    expect(product.rows[0].archived_at).toEqual(archivedAt);
    // ...а purge_after перезаписывается на новое поколение (deleted_at+30d).
    expect(product.rows[0].purge_after).toEqual(new Date(DELETED_AT.getTime() + 30 * 86_400_000));
    // LATERAL выбрал последний sleep не старше текущей архивации — старый
    // done; новый queued-sleep поверх подтверждённого не ставится.
    expect((await latestSleep()).id).toBe(sleepId);
    expect((await latestSleep()).status).toBe('done');
    expect((await pool.query(`SELECT count(*)::int AS n FROM product_provision_jobs WHERE product_id=$1 AND kind='sleep'`, [PRODUCT_ID])).rows[0].n).toBe(1);
  });
});
