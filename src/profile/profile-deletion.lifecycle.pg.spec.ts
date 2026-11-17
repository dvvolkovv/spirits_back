import { ServiceUnavailableException } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { readFileSync } from 'fs';
import { Pool } from 'pg';
import {
  AccountDeletionLifecycle,
  EXPLICIT_DELETION_UNAVAILABLE,
} from '../account-deletion/account-deletion.lifecycle';
import { AccountDeletionJobs } from '../account-deletion/account-deletion.jobs';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { AccountDeletionPlanner } from '../account-deletion/account-deletion.planner';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import { AccountDeletionRunner } from '../account-deletion/account-deletion.runner';
import {
  ACCOUNT_DELETION_RETENTION_MS,
  DeletionRetryError,
  deletionResourceHash,
} from '../account-deletion/account-deletion.safe';
import type {
  DeletionAccount,
  DeletionDiscoverer,
  DeletionExecution,
  DeletionJobRow,
  DeletionOrigin,
  DeletionPlan,
  DeletionResourceType,
} from '../account-deletion/account-deletion.types';
import type { ExtractEnv } from '../chat/chat-files/extract';
import { ProfileAccountDeletionAdapter } from './profile-account-deletion.adapter';
import { ProfileAccountDeletionRecapture } from './profile-account-deletion.discovery';
import { ProfileService } from './profile.service';

/**
 * Task 18 — явное DELETE против живой PostgreSQL: begin (поколение + план в
 * одной транзакции), immediate-стопы синхронно, затем core finalize.
 *
 * Состав стека:
 *  - AccountDeletionLifecycle / AccountDeletionRunner / AccountDeletionJobs /
 *    AccountDeletionPlanner / ProfileAccountDeletionAdapter / Recapture —
 *    настоящие (SQL, fencing, санитайзер, транзакции — как в проде);
 *  - реестр исполнителей — фейк: журнал порядка вызовов + delegация core в
 *    настоящий адаптер (доменные таблицы стопов в этой схеме не создаём);
 *  - discoverers — фейки: пять immediate-стопов и (в тесте I3-T11) поздний
 *    chat-file.purge; настоящие discoverers из каталога читают доменные
 *    таблицы других модулей, которых в схеме спека нет.
 *
 * Планировщик обёрнут «ступеньками» (persist по одной задаче с паузой 2 мс):
 * у immediate-задач next_attempt_at=now(), и без различимых меток порядок
 * claim'а решал бы случайный uuid tie-break (id DEFAULT gen_random_uuid).
 *
 * Таблицы — faithful-копии 001_core_schema.sql (без префикса public., чтобы
 * попасть в per-pid SCHEMA) плюс настоящие миграции identity и
 * account-deletion через readFileSync (прецедент profile-account-deletion.
 * pg.spec.ts, Task 17). payments/token_transactions/login_history не нужны:
 * их сохранность проверяет спек Task 17.
 */

const USER = 'u-deleted';
const PERSONAL_CANARY = 'ЛИЧНЫЙ-ТЕКСТ';
const BUCKET = 'linkeon-chat-files';
const FILE_KEY = 'late/file.pdf';
const FILE_KEY_B64 = Buffer.from(FILE_KEY, 'utf8').toString('base64url');
const TEST_ENV: ExtractEnv = {
  publicBaseUrl: 'https://minio.test',
  agentUrl: 'https://agent.test',
  backendUrl: 'https://backend.test',
};
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const STOP_TYPES: DeletionResourceType[] = [
  'routine.stop',
  'telegram.stop',
  'product.stop',
  'calendar.stop',
  'voice.stop',
];

// ==================== wiring (без PG) ====================

describe('wiring explicit deletion (Task 18)', () => {
  it('AccountDeletionModule провайдит и экспортирует lifecycle ровно один раз', () => {
    const providers =
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AccountDeletionModule) ?? [];
    const moduleExports =
      Reflect.getMetadata(MODULE_METADATA.EXPORTS, AccountDeletionModule) ?? [];
    expect(
      providers.filter((item: unknown) => item === AccountDeletionLifecycle),
    ).toHaveLength(1);
    expect(
      moduleExports.filter((item: unknown) => item === AccountDeletionLifecycle),
    ).toHaveLength(1);
  });

  it('ProfileService.deleteProfile делегирует lifecycle и возвращает {success:true}', async () => {
    const deleteExplicit = jest.fn(async (_userId: string) => undefined);
    const profile = new ProfileService(
      { query: jest.fn() } as any,
      { deleteExplicit } as any,
    );

    await expect(profile.deleteProfile('u-1')).resolves.toEqual({ success: true });
    expect(deleteExplicit).toHaveBeenCalledWith('u-1');
  });

  it('deleteProfile пропускает 503 с фиксированным безопасным сообщением', async () => {
    const deleteExplicit = jest.fn(async (_userId: string) => {
      throw new ServiceUnavailableException(EXPLICIT_DELETION_UNAVAILABLE);
    });
    const profile = new ProfileService(
      { query: jest.fn() } as any,
      { deleteExplicit } as any,
    );

    const error = await profile.deleteProfile('u-1').catch((e) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toBe(EXPLICIT_DELETION_UNAVAILABLE);
    expect(error.getStatus()).toBe(503);
  });
});

// ==================== PG-часть ====================

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `profile_del_lifecycle_spec_${process.pid}`;

/** Журнал вызовов + делегация core настоящему адаптеру. */
class FakeRegistry {
  private readonly failures = new Map<string, unknown>();
  private core: ProfileAccountDeletionAdapter | null = null;

  constructor(readonly calls: string[]) {}

  setCore(adapter: ProfileAccountDeletionAdapter): void {
    this.core = adapter;
  }

  assertReady(): void {}

  fail(resourceType: DeletionResourceType, error: unknown): void {
    this.failures.set(resourceType, error);
  }

  getExecutor(resourceType: DeletionResourceType) {
    return {
      resourceTypes: [resourceType],
      execute: async (job: DeletionJobRow, ctx: DeletionExecution) => {
        this.calls.push(
          resourceType === 'account.core.immediate' ? 'core.immediate' : resourceType,
        );
        const failure = this.failures.get(resourceType);
        if (failure) throw failure;
        if (
          resourceType === 'account.core.immediate'
          || resourceType === 'account.core.purge'
        ) {
          if (!this.core) throw new Error('core adapter not set');
          await this.core.execute(job, ctx);
        }
      },
    };
  }
}

const stopDiscoverer: DeletionDiscoverer = async () => ({
  jobs: STOP_TYPES.map((resourceType) => ({
    resourceType,
    resourceKey: resourceType.split('.')[0],
    phase: 'immediate' as const,
    payload: {},
  })),
  skips: [],
});

const chatFileDiscoverer: DeletionDiscoverer = async () => ({
  jobs: [{
    resourceType: 'chat-file.purge' as DeletionResourceType,
    resourceKey: deletionResourceHash(BUCKET, FILE_KEY),
    phase: 'purge' as const,
    payload: { bucket: BUCKET, key: FILE_KEY_B64 },
  }],
  skips: [],
});

/** Обёртка планировщика: журнал 'begin' + ступеньки persist (см. шапку). */
function staggered(
  inner: AccountDeletionPlanner,
  calls: string[],
): AccountDeletionPlanner {
  return {
    collect: async (
      dbArg: any,
      account: DeletionAccount,
      origin: DeletionOrigin,
    ) => {
      // collect вызывается ровно один раз — внутри begin-транзакции.
      calls.push('begin');
      return inner.collect(dbArg, account, origin);
    },
    persist: async (dbArg: any, account: DeletionAccount, plan: DeletionPlan) => {
      for (const job of plan.jobs) {
        await inner.persist(dbArg, account, { jobs: [job], skips: [] });
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    },
  } as unknown as AccountDeletionPlanner;
}

maybe('explicit deletion lifecycle against PostgreSQL (Task 18)', () => {
  jest.setTimeout(60_000);

  let admin: Pool;
  let pool: Pool;
  let origBucketEnv: string | undefined;

  const db = {
    query: (sql: string, params?: any[]) => pool.query(sql, params as any[]),
    getClient: () => pool.connect(),
  };

  async function rows(sql: string, params: any[] = []): Promise<any[]> {
    return (await pool.query(sql, params)).rows;
  }

  function makeStack(discoverers: DeletionDiscoverer[] = [stopDiscoverer]) {
    const calls: string[] = [];
    const jobs = new AccountDeletionJobs(db as any);
    const registry = new FakeRegistry(calls);
    const neo4j = { deleteUserGraphStrict: jest.fn(async (_userId: string) => undefined) };
    const adapter = new ProfileAccountDeletionAdapter(
      db as any,
      jobs,
      new ProfileAccountDeletionRecapture(
        db as any,
        new AccountDeletionPlanner([]),
        TEST_ENV,
      ),
      neo4j as any,
      new AccountDeletionRegistry(),
    );
    registry.setCore(adapter);
    const runner = new AccountDeletionRunner(db as any, jobs as any, registry as any);
    const planner = staggered(new AccountDeletionPlanner(discoverers), calls);
    const lifecycle = new AccountDeletionLifecycle(
      db as any,
      planner as any,
      jobs,
      registry as any,
      runner,
    );
    const profile = new ProfileService(db as any, lifecycle);
    return { calls, jobs, registry, neo4j, runner, planner, lifecycle, profile };
  }

  async function seedUser(
    userId: string,
    state: string | null,
    opts: { deletionId?: string | null; deletedAt?: Date | null } = {},
  ): Promise<void> {
    await pool.query(
      `INSERT INTO user_id
         (internal_id, state, deletion_id, deleted_at,
          password_hash, primary_email)
       VALUES ($1,$2,$3,$4,'HASH-CANARY','deleted@example.test')`,
      [userId, state, opts.deletionId ?? null, opts.deletedAt ?? null],
    );
  }

  async function userRow(userId: string): Promise<any> {
    const r = await rows(
      `SELECT state, deletion_id, deleted_at, password_hash
         FROM user_id WHERE internal_id=$1`,
      [userId],
    );
    return r[0];
  }

  async function seedHistory(userId: string, content: string): Promise<void> {
    await pool.query(
      `INSERT INTO custom_chat_history (session_id, sender_type, content, message_type)
       VALUES ($1,'human',$2,'text')`,
      [`${userId}_12`, content],
    );
  }

  async function seedIdentity(userId: string, provider: string, sub: string): Promise<void> {
    await pool.query(
      `INSERT INTO user_identities (user_id, provider, provider_sub, email_verified)
       VALUES ($1,$2,$3,$2='email')`,
      [userId, provider, sub],
    );
  }

  async function historyCount(userId: string): Promise<number> {
    const r = await rows(
      `SELECT count(*)::int AS n FROM custom_chat_history
        WHERE session_id LIKE $1 || '\\_%' ESCAPE '\\'`,
      [userId],
    );
    return r[0].n;
  }

  async function identityCount(userId: string): Promise<number> {
    const r = await rows(
      `SELECT count(*)::int AS n FROM user_identities WHERE user_id=$1`,
      [userId],
    );
    return r[0].n;
  }

  async function jobCount(): Promise<number> {
    const r = await rows(`SELECT count(*)::int AS n FROM account_deletion_jobs`);
    return r[0].n;
  }

  async function jobRows(deletionId?: string): Promise<any[]> {
    return rows(
      `SELECT resource_type, resource_key, phase, status, attempts, last_error_kind
         FROM account_deletion_jobs
        WHERE ($1::uuid IS NULL OR deletion_id = $1)
        ORDER BY resource_type`,
      [deletionId ?? null],
    );
  }

  beforeAll(async () => {
    // Бакет фиксирован: chatFilesBucket() читает process.env.
    origBucketEnv = process.env.MINIO_BUCKET_CHAT_FILES;
    process.env.MINIO_BUCKET_CHAT_FILES = BUCKET;

    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 2, options: `-c search_path=${SCHEMA}` });

    // user_id — дословно 001_core_schema.sql (:9599) + UNIQUE (:10908):
    // FK user_identities(internal_id) требует уникальности.
    await pool.query(`
      CREATE TABLE user_id (
          id uuid DEFAULT gen_random_uuid() NOT NULL,
          primary_phone text,
          primary_email text,
          contacts json,
          create_date timestamp without time zone DEFAULT now(),
          update_date timestamp without time zone DEFAULT now(),
          state text,
          internal_id character varying NOT NULL
      );
      ALTER TABLE ONLY user_id
          ADD CONSTRAINT user_id_internal_id_key UNIQUE (internal_id);
    `);

    // Настоящие миграции: identity (user_identities + password_hash/
    // signup_method/welcome_bonus_at) и account-deletion (deleted_at/
    // deletion_id + account_deletion_jobs + индексы).
    await pool.query(readFileSync('src/identity/migrations/001_identity_init.sql', 'utf8'));
    await pool.query(readFileSync('src/account-deletion/migrations/001_account_deletion.sql', 'utf8'));

    // custom_chat_history — дословно 001_core_schema.sql (:2364) + seq (:2431)
    // + default (:10489).
    await pool.query(`
      CREATE TABLE custom_chat_history (
          id integer NOT NULL,
          session_id text NOT NULL,
          sender_type character varying(10) NOT NULL,
          agent integer,
          content text NOT NULL,
          created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
          message_type character varying(20) DEFAULT 'text'::character varying NOT NULL,
          tokens_used integer DEFAULT 0,
          CONSTRAINT custom_chat_history_message_type_check CHECK (((message_type)::text = ANY (ARRAY[('text'::character varying)::text, ('image'::character varying)::text]))),
          CONSTRAINT custom_chat_history_sender_type_check CHECK (((sender_type)::text = ANY (ARRAY[('ai'::character varying)::text, ('human'::character varying)::text])))
      );
      CREATE SEQUENCE custom_chat_history_id_seq
          AS integer
          START WITH 1
          INCREMENT BY 1
          NO MINVALUE
          NO MAXVALUE
          CACHE 1;
      ALTER SEQUENCE custom_chat_history_id_seq OWNED BY custom_chat_history.id;
      ALTER TABLE ONLY custom_chat_history ALTER COLUMN id SET DEFAULT nextval('custom_chat_history_id_seq'::regclass);
    `);

    // ai_profiles_consolidated — дословно (:841) + seq + UNIQUE(user_id).
    await pool.query(`
      CREATE TABLE ai_profiles_consolidated (
          id integer NOT NULL,
          user_id text NOT NULL,
          created_at timestamp with time zone DEFAULT now(),
          updated_at timestamp with time zone DEFAULT now(),
          preferred_agent character varying,
          isadmin boolean DEFAULT false,
          tokens bigint DEFAULT 0 NOT NULL,
          email text,
          profile_data jsonb DEFAULT '{}'::jsonb
      );
      CREATE SEQUENCE ai_profiles_consolidated_id_seq
          AS integer
          START WITH 1
          INCREMENT BY 1
          NO MINVALUE
          NO MAXVALUE
          CACHE 1;
      ALTER SEQUENCE ai_profiles_consolidated_id_seq OWNED BY ai_profiles_consolidated.id;
      ALTER TABLE ONLY ai_profiles_consolidated ALTER COLUMN id SET DEFAULT nextval('ai_profiles_consolidated_id_seq'::regclass);
      ALTER TABLE ONLY ai_profiles_consolidated
          ADD CONSTRAINT ai_profiles_consolidated_user_id_key UNIQUE (user_id);
    `);

    // action_plans — настоящая миграция модуля.
    await pool.query(readFileSync('src/chat/action-plans/migrations/001_action_plans.sql', 'utf8'));
    // chat_context_resets — настоящая миграция модуля: core стирает и точки
    // «Чистого листа», без таблицы finalize упал бы на DELETE.
    await pool.query(readFileSync('src/chat/context-reset/migrations/001_chat_context_resets.sql', 'utf8'));

    // tg_user_identities — дословно 001_tg_bot_schema.sql (только эта таблица).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tg_user_identities (
        linkeon_user_id  text PRIMARY KEY,
        tg_user_id       bigint UNIQUE NOT NULL,
        tg_username      text,
        tg_first_name    text,
        bound_at         timestamptz NOT NULL DEFAULT now()
      );
    `);
  });

  afterAll(async () => {
    if (origBucketEnv === undefined) delete process.env.MINIO_BUCKET_CHAT_FILES;
    else process.env.MINIO_BUCKET_CHAT_FILES = origBucketEnv;
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE account_deletion_jobs, custom_chat_history, action_plans,
                chat_context_resets,
                ai_profiles_consolidated, user_identities, tg_user_identities,
                user_id`,
    );
  });

  it('DELETE создаёт generation, jobs и вызывает stop до core finalize', async () => {
    await seedUser(USER, 'active');
    await seedHistory(USER, PERSONAL_CANARY);
    await seedIdentity(USER, 'email', 'deleted@example.test');
    const { profile, calls, neo4j } = makeStack();

    await profile.deleteProfile(USER);

    const u = await userRow(USER);
    expect(u.state).toBe('deleted');
    expect(u.deleted_at).not.toBeNull();
    expect(u.deletion_id).toMatch(UUID_RE);
    expect(calls).toEqual([
      'begin',
      'routine.stop',
      'telegram.stop',
      'product.stop',
      'calendar.stop',
      'voice.stop',
      'core.immediate',
    ]);
    expect(await historyCount(USER)).toBe(0);
    // Расширение плана: identities стерты, граф вызван, tombstone на месте,
    // все задачи поколения завершены и других нет.
    expect(await identityCount(USER)).toBe(0);
    expect(neo4j.deleteUserGraphStrict).toHaveBeenCalledWith(USER);
    expect(u.password_hash).toBeNull();
    const js = await jobRows(u.deletion_id);
    expect(js.map((row) => row.resource_type)).toEqual(
      ['account.core.immediate', ...STOP_TYPES].slice().sort(),
    );
    expect(js.every((row) => row.status === 'done')).toBe(true);
    expect(await jobCount()).toBe(6);
  });

  it('stop failure не удаляет history/identities и не возвращает ложный success', async () => {
    await seedUser(USER, 'active');
    await seedHistory(USER, PERSONAL_CANARY);
    await seedIdentity(USER, 'email', 'deleted@example.test');
    const { profile, registry } = makeStack();
    registry.fail('telegram.stop', new DeletionRetryError('timeout'));

    await expect(profile.deleteProfile(USER))
      .rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(await historyCount(USER)).toBe(1);
    expect(await identityCount(USER)).toBe(1);
    expect((await userRow(USER)).deletion_id).toBeTruthy();
  });

  it('упавший stop остаётся на retry, core не заклеймлен, сообщение фиксировано', async () => {
    await seedUser(USER, 'active');
    await seedHistory(USER, PERSONAL_CANARY);
    const { profile, calls, registry } = makeStack();
    registry.fail('telegram.stop', new DeletionRetryError('timeout'));

    const error = await profile.deleteProfile(USER).catch((e) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toBe(EXPLICIT_DELETION_UNAVAILABLE);
    expect(error.getStatus()).toBe(503);
    const u = await userRow(USER);
    // Фиксированное безопасное сообщение: HTTP не раскрывает deletionId/userId.
    expect(error.message).not.toContain(u.deletion_id);
    expect(error.message).not.toContain(USER);
    expect(calls).toEqual([
      'begin',
      'routine.stop',
      'telegram.stop',
      'product.stop',
      'calendar.stop',
      'voice.stop',
    ]);
    const byType = new Map(
      (await jobRows(u.deletion_id)).map((row) => [row.resource_type, row]),
    );
    expect(byType.get('telegram.stop')).toMatchObject({
      status: 'failed', last_error_kind: 'timeout', attempts: 1,
    });
    for (const type of ['routine.stop', 'product.stop', 'calendar.stop', 'voice.stop']) {
      expect(byType.get(type)).toMatchObject({ status: 'done' });
    }
    // Core не заклеймлен и не запущен — ждёт retry поколения.
    expect(byType.get('account.core.immediate')).toMatchObject({
      status: 'pending', attempts: 0,
    });
  });

  it('повторный DELETE того же поколения доводит удаление без дублей задач', async () => {
    await seedUser(USER, 'active');
    await seedHistory(USER, PERSONAL_CANARY);
    await seedIdentity(USER, 'email', 'deleted@example.test');
    const first = makeStack();
    first.registry.fail('telegram.stop', new DeletionRetryError('timeout'));
    await expect(first.profile.deleteProfile(USER))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    const generation = (await userRow(USER)).deletion_id;

    // Снимаем backoff упавшего stop'а (retryDelayMs) — как это сделал бы
    // почасовой worker или ручной retry.
    await pool.query(
      `UPDATE account_deletion_jobs
          SET next_attempt_at = now() - interval '1 minute'
        WHERE resource_type = 'telegram.stop'`,
    );
    const second = makeStack();

    await second.profile.deleteProfile(USER);

    expect(second.calls).toEqual(['begin', 'telegram.stop', 'core.immediate']);
    const u = await userRow(USER);
    expect(u.deletion_id).toBe(generation);
    expect(await historyCount(USER)).toBe(0);
    expect(await identityCount(USER)).toBe(0);
    const js = await jobRows(generation);
    expect(js).toHaveLength(6);
    expect(js.every((row) => row.status === 'done')).toBe(true);
    expect(await jobCount()).toBe(6);
  });

  it('повторный DELETE после успеха: то же поколение, без дублей и повторного core', async () => {
    await seedUser(USER, 'active');
    await seedHistory(USER, PERSONAL_CANARY);
    const first = makeStack();
    await first.profile.deleteProfile(USER);
    const u1 = await userRow(USER);
    const snapshot = JSON.stringify(await jobRows(u1.deletion_id));

    const second = makeStack();
    await expect(second.profile.deleteProfile(USER)).resolves.toEqual({ success: true });

    expect(second.calls).toEqual(['begin']);
    const u2 = await userRow(USER);
    expect(u2.deletion_id).toBe(u1.deletion_id);
    expect(JSON.stringify(await jobRows(u2.deletion_id))).toBe(snapshot);
    expect(await jobCount()).toBe(6);
  });

  it('после reactivation новое удаление получает новый generation', async () => {
    await seedUser(USER, 'active');
    const first = makeStack();
    await first.profile.deleteProfile(USER);
    const generation1 = (await userRow(USER)).deletion_id;

    // Reactivation в IdentityService: только state (deletion_id/deleted_at не
    // очищает) — begin обязан выпустить новый UUID, а не переиспользовать старый.
    await pool.query(
      `UPDATE user_id SET state='active', update_date=now() WHERE internal_id=$1`,
      [USER],
    );
    await seedHistory(USER, PERSONAL_CANARY);
    const second = makeStack();

    await second.profile.deleteProfile(USER);

    const u = await userRow(USER);
    expect(u.state).toBe('deleted');
    expect(u.deletion_id).toMatch(UUID_RE);
    expect(u.deletion_id).not.toBe(generation1);
    expect(await historyCount(USER)).toBe(0);
    expect(second.calls).toEqual([
      'begin',
      'routine.stop',
      'telegram.stop',
      'product.stop',
      'calendar.stop',
      'voice.stop',
      'core.immediate',
    ]);
    // Задачи старого поколения не пересоздавались: 6 + 6.
    expect(await jobCount()).toBe(12);
    expect(await jobRows(u.deletion_id)).toHaveLength(6);
  });

  it('historical deleted без generation — success без jobs и stops', async () => {
    await seedUser(USER, 'deleted', {
      deletionId: null,
      deletedAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    await seedHistory(USER, PERSONAL_CANARY);
    const { profile, calls } = makeStack();

    await expect(profile.deleteProfile(USER)).resolves.toEqual({ success: true });

    expect(calls).toEqual([]);
    // Ничего не тронуто: поколения нет — удаление не включается.
    expect(await historyCount(USER)).toBe(1);
    const u = await userRow(USER);
    expect(u.state).toBe('deleted');
    expect(u.deletion_id).toBeNull();
    expect(await jobCount()).toBe(0);
  });

  it('состояния NULL и blocked не трогаем (FU-T11-2)', async () => {
    await seedUser('u-blocked', 'blocked');
    await seedUser('u-nullstate', null);
    const { profile, calls } = makeStack();

    await expect(profile.deleteProfile('u-blocked')).resolves.toEqual({ success: true });
    await expect(profile.deleteProfile('u-nullstate')).resolves.toEqual({ success: true });

    expect(calls).toEqual([]);
    expect((await userRow('u-blocked')).state).toBe('blocked');
    expect((await userRow('u-nullstate')).state).toBeNull();
    expect(await jobCount()).toBe(0);
  });

  it('несуществующий пользователь — идемпотентный success без jobs', async () => {
    const { profile, calls } = makeStack();

    await expect(profile.deleteProfile('u-ghost')).resolves.toEqual({ success: true });

    expect(calls).toEqual([]);
    expect(await jobCount()).toBe(0);
  });

  it('chat-file.purge персистится внутри begin-транзакции до удаления history (I3-T11)', async () => {
    await seedUser(USER, 'active');
    await seedHistory(
      USER,
      `[file](https://minio.test/${BUCKET}/${FILE_KEY})\n${PERSONAL_CANARY}`,
    );
    const { profile, registry } = makeStack([stopDiscoverer, chatFileDiscoverer]);
    registry.fail('telegram.stop', new DeletionRetryError('timeout'));

    await expect(profile.deleteProfile(USER))
      .rejects.toBeInstanceOf(ServiceUnavailableException);

    // Core не выполнялся: история цела, recapture не вызывался.
    expect(await historyCount(USER)).toBe(1);
    const purge = await rows(
      `SELECT resource_key, phase, payload_jsonb, next_attempt_at
         FROM account_deletion_jobs WHERE resource_type='chat-file.purge'`,
    );
    expect(purge).toHaveLength(1);
    expect(purge[0].phase).toBe('purge');
    expect(purge[0].resource_key).toBe(deletionResourceHash(BUCKET, FILE_KEY));
    // Сырой ключ в payload запрещён (fail-closed sanitizer) — только base64url.
    expect(purge[0].payload_jsonb).toEqual({ bucket: BUCKET, key: FILE_KEY_B64 });
    // Purge отложен на retention от deleted_at поколения, созданного begin'ом.
    const u = await userRow(USER);
    expect(new Date(purge[0].next_attempt_at).getTime())
      .toBe(new Date(u.deleted_at).getTime() + ACCOUNT_DELETION_RETENTION_MS);
    const payloadJson = JSON.stringify(purge[0].payload_jsonb);
    expect(payloadJson).not.toContain(PERSONAL_CANARY);
    expect(payloadJson).not.toContain(USER);
    expect(payloadJson).not.toContain(FILE_KEY);
  });
});
