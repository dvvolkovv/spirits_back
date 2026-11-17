import { MODULE_METADATA } from '@nestjs/common/constants';
import { readFileSync } from 'fs';
import { Pool } from 'pg';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { AccountDeletionJobs } from '../account-deletion/account-deletion.jobs';
import { AccountDeletionPlanner } from '../account-deletion/account-deletion.planner';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import {
  ACCOUNT_DELETION_RETENTION_MS,
  DeletionCancelledError,
  DeletionRetryError,
  deletionResourceHash,
} from '../account-deletion/account-deletion.safe';
import type {
  DeletionExecution,
  DeletionJobRow,
} from '../account-deletion/account-deletion.types';
import type { ExtractEnv } from '../chat/chat-files/extract';
import { ProfileModule } from './profile.module';
import { ProfileAccountDeletionAdapter } from './profile-account-deletion.adapter';
import { ProfileAccountDeletionRecapture } from './profile-account-deletion.discovery';

/**
 * Task 17 — account core: recapture, graph и атомарный local finalize.
 *
 * Семантика (план):
 *  - core execute ВСЕГДА начинается с повторного capture ссылок на файлы
 *    переписки (discoverChatFiles): история стирается в той же execute, а
 *    chat-file.purge живёт отдельными job'ами — поздняя ссылка, пришедшая
 *    между планированием и finalize, обязана пережить удаление истории;
 *  - каждый деструктивный шаг fenced поколением удаления (state='deleted'
 *    AND deletion_id): реактивация между graph и local delete отменяет
 *    finalize (kind 'cancelled'), локальные строки остаются;
 *  - local finalize — одна транзакция: SELECT ... FOR UPDATE + gen-assert
 *    (lockAndAssertCurrent) и fenced DELETE/UPDATE (deleteOwnedCoreRows);
 *  - payments, token_transactions и login_history (security/finance logs)
 *    сохраняются; user_id остаётся tombstone (internal_id, state, deletion_id,
 *    deleted_at не трогаются); account_deletion_jobs остаются как audit;
 *  - merge core purge не трогает identities, уже перенесённые survivor-у
 *    (Task 19 переносит их на stop-фазе); fencing по internal_id loser'а
 *    естественно их не задевает.
 *
 * Таблицы — faithful-копии 001_core_schema.sql (без префикса public., чтобы
 * попасть в per-pid SCHEMA) плюс настоящие миграции identity и
 * account-deletion через readFileSync (прецедент planner.pg.spec).
 */

const USER = 'u-deleted';
const OTHER = 'u-other';
const SURVIVOR = 'u-survivor';
const LOSER = 'u-loser';
/** Префикс-коллизия: internal_id, начинающийся так же (LIKE без экранирования `_` поймал бы его сессию). */
const COLLISION = 'u-deletedX';
// План использует 'd-1'/'d-new'; колонка deletion_id — uuid, поэтому
// фиксированные валидные UUID (отклонение задокументировано в отчёте).
const DELETION_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const NEW_DELETION_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const MERGE_DELETION_ID = 'cccccccc-3333-4333-8333-333333333333';
const DELETED_AT = new Date('2026-11-01T00:00:00.000Z');
const PERSONAL_CANARY = 'ЛИЧНЫЙ-ТЕКСТ';
const PROFILE_CANARY = 'КАНАРЕЙКА-ИМЯ';
const BUCKET = 'linkeon-chat-files';
const FILE_KEY = 'late/file.pdf';
const FILE_URL = `https://minio.test/${BUCKET}/${FILE_KEY}`;
const FILE_KEY_B64 = Buffer.from(FILE_KEY, 'utf8').toString('base64url');
const TEST_ENV: ExtractEnv = {
  publicBaseUrl: 'https://minio.test',
  agentUrl: 'https://agent.test',
  backendUrl: 'https://backend.test',
};

// ==================== wiring (без PG) ====================

describe('wiring account.core.* (Task 17)', () => {
  it('ProfileModule импортирует AccountDeletionModule и провайдит адаптер с recapture', () => {
    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, ProfileModule) ?? []).flat(Infinity);
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ProfileModule) ?? [];
    expect(imports.filter((item: unknown) => item === AccountDeletionModule)).toHaveLength(1);
    expect(providers.filter((item: unknown) => item === ProfileAccountDeletionAdapter)).toHaveLength(1);
    expect(providers.some((item: any) =>
      typeof item === 'object' && item !== null && item.provide === ProfileAccountDeletionRecapture,
    )).toBe(true);
  });

  it('adapter регистрирует account.core.immediate и account.core.purge', () => {
    const registry = { register: jest.fn() } as any;
    const adapter = new ProfileAccountDeletionAdapter(
      { query: jest.fn(), getClient: jest.fn() } as any,
      { assertNoImmediateBlockers: jest.fn(), lockAndAssertCurrent: jest.fn() } as any,
      { collectAndPersist: jest.fn() } as any,
      { deleteUserGraphStrict: jest.fn() } as any,
      registry,
    );
    expect(adapter.resourceTypes).toEqual(['account.core.immediate', 'account.core.purge']);
    adapter.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(adapter);
  });
});

// ==================== PG-часть ====================

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `profile_acct_del_spec_${process.pid}`;

maybe('profile account deletion against PostgreSQL (Task 17)', () => {
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

  function makeStack() {
    const jobs = new AccountDeletionJobs(db as any);
    const recapture = new ProfileAccountDeletionRecapture(
      db as any,
      new AccountDeletionPlanner([]),
      TEST_ENV,
    );
    const neo4j = { deleteUserGraphStrict: jest.fn(async (_userId: string) => undefined) };
    const adapter = new ProfileAccountDeletionAdapter(
      db as any,
      jobs,
      recapture,
      neo4j as any,
      new AccountDeletionRegistry(),
    );
    return { jobs, recapture, neo4j, adapter };
  }

  /** Реальный fencing-контекст: assertCurrent идёт в живую БД. */
  function makeCtx(jobs: AccountDeletionJobs): DeletionExecution {
    return {
      db: { query: (sql: string, params?: unknown[]) => pool.query(sql, params as any[]) },
      assertCurrent: (job: DeletionJobRow) => jobs.assertCurrent(job),
    };
  }

  async function seedDeletedAccount(opts: {
    userId: string;
    deletionId: string;
    hash?: string | null;
    email?: string | null;
    phone?: string | null;
    contacts?: string | null;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO user_id
         (internal_id, state, deleted_at, deletion_id,
          password_hash, primary_email, primary_phone, welcome_bonus_at,
          contacts)
       VALUES ($1,'deleted',$2,$3,$4,$5,$6,$2,$7::json)`,
      [opts.userId, DELETED_AT, opts.deletionId,
        opts.hash ?? null, opts.email ?? null, opts.phone ?? null,
        opts.contacts ?? null],
    );
  }

  async function seedActiveAccount(userId: string): Promise<void> {
    await pool.query(
      `INSERT INTO user_id (internal_id, state) VALUES ($1,'active')`,
      [userId],
    );
  }

  async function reactivate(userId: string, newDeletionId: string): Promise<void> {
    await pool.query(
      `UPDATE user_id
          SET state='active', deletion_id=$2, deleted_at=NULL
        WHERE internal_id=$1`,
      [userId, newDeletionId],
    );
  }

  async function seedHistory(
    userId: string,
    content: string,
    sessionSuffix = '_12',
  ): Promise<void> {
    await pool.query(
      `INSERT INTO custom_chat_history (session_id, sender_type, content, message_type)
       VALUES ($1,'human',$2,'text')`,
      [`${userId}${sessionSuffix}`, content],
    );
  }

  async function seedIdentity(userId: string, provider: string, sub: string): Promise<void> {
    await pool.query(
      `INSERT INTO user_identities (user_id, provider, provider_sub, email_verified)
       VALUES ($1,$2,$3,$2='email')`,
      [userId, provider, sub],
    );
  }

  async function seedCoreJob(
    userId: string,
    deletionId: string,
    resourceType: 'account.core.immediate' | 'account.core.purge',
  ): Promise<void> {
    await pool.query(
      `INSERT INTO account_deletion_jobs
         (deletion_id, user_id, resource_type, resource_key, phase,
          payload_jsonb, status, next_attempt_at)
       VALUES ($1,$2,$3,'account',$4,'{}'::jsonb,'pending', now())`,
      [deletionId, userId, resourceType,
        resourceType === 'account.core.immediate' ? 'immediate' : 'purge'],
    );
  }

  async function claimCoreJob(
    jobs: AccountDeletionJobs,
    deletionId: string,
  ): Promise<DeletionJobRow> {
    const job = await jobs.claimNext(deletionId);
    if (!job) throw new Error('core job не заклеймился');
    return job;
  }

  async function historyCount(userId: string): Promise<number> {
    const r = await rows(
      `SELECT count(*)::int AS n FROM custom_chat_history
        WHERE session_id LIKE $1 || '\\_%' ESCAPE '\\'`,
      [userId],
    );
    return r[0].n;
  }

  /** Точка «Чистого листа» пары «пользователь + ассистент '10'». */
  async function seedContextReset(userId: string): Promise<void> {
    await pool.query(
      `INSERT INTO chat_context_resets (user_id, assistant_id, reset_at) VALUES ($1, '10', now())`,
      [userId],
    );
  }

  async function contextResetCount(userId: string): Promise<number> {
    const r = await rows(
      `SELECT count(*)::int AS n FROM chat_context_resets WHERE user_id = $1`,
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

  /** Срез того, что core ОБЯЗАН сохранить: платежи, ledger, security logs. */
  async function preservedSnapshot(): Promise<string> {
    const payments = await rows(
      `SELECT id, user_id, payment_id, package_id, amount::text AS amount, tokens,
              status, payment_url, created_at, updated_at, completed_at
         FROM payments ORDER BY created_at, id`);
    const ledger = await rows(
      `SELECT id, user_id, transaction_type, amount, balance_after, description,
              metadata, created_at
         FROM token_transactions ORDER BY created_at, id`);
    const logins = await rows(
      `SELECT id, "timestamp", user_id, session_id, device_id, device_description,
              ip_address
         FROM login_history ORDER BY id`);
    return JSON.stringify({ payments, ledger, logins });
  }

  beforeAll(async () => {
    // Бакет фиксирован: chatFilesBucket() читает process.env.
    origBucketEnv = process.env.MINIO_BUCKET_CHAT_FILES;
    process.env.MINIO_BUCKET_CHAT_FILES = BUCKET;

    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 2, options: `-c search_path=${SCHEMA}` });

    // Enum'ы — дословно 001_core_schema.sql (:48, :72).
    await pool.query(`
      CREATE TYPE payment_status_enum AS ENUM (
          'pending',
          'succeeded',
          'canceled',
          'failed'
      );
      CREATE TYPE transaction_type_enum AS ENUM (
          'purchase',
          'consumed',
          'bonus',
          'refund',
          'adjustment',
          'coupon'
      );
    `);

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
    // deletion_id + account_deletion_jobs + индексы). Бэкфиллы на пустых
    // таблицах — 0 строк.
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

    // ai_profiles_consolidated — дословно (:841) + seq (:10461 region)
    // + UNIQUE(user_id) (:10637).
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
    // chat_context_resets — точки «Чистого листа», настоящая миграция модуля.
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

    // payments (:5805), token_transactions (:8885), login_history (:3862) —
    // дословно; то, что core НЕ трогает.
    await pool.query(`
      CREATE TABLE payments (
          id uuid DEFAULT gen_random_uuid() NOT NULL,
          user_id text NOT NULL,
          payment_id text NOT NULL,
          package_id text,
          amount numeric(10,2) NOT NULL,
          tokens bigint NOT NULL,
          status payment_status_enum DEFAULT 'pending'::payment_status_enum NOT NULL,
          payment_url text,
          created_at timestamp with time zone DEFAULT now(),
          updated_at timestamp with time zone DEFAULT now(),
          completed_at timestamp with time zone
      );
      CREATE TABLE token_transactions (
          id uuid DEFAULT gen_random_uuid() NOT NULL,
          user_id text NOT NULL,
          transaction_type transaction_type_enum NOT NULL,
          amount bigint NOT NULL,
          balance_after bigint NOT NULL,
          description text,
          metadata jsonb,
          created_at timestamp with time zone DEFAULT now()
      );
      CREATE TABLE login_history (
          id integer NOT NULL,
          "timestamp" timestamp with time zone DEFAULT now() NOT NULL,
          user_id integer NOT NULL,
          session_id character varying(254),
          device_id character(36) NOT NULL,
          device_description text NOT NULL,
          ip_address text NOT NULL
      );
      ALTER TABLE login_history ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
          SEQUENCE NAME login_history_id_seq
          START WITH 1
          INCREMENT BY 1
          NO MINVALUE
          NO MAXVALUE
          CACHE 1
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
                payments, token_transactions, login_history, user_id`,
    );
  });

  it('повторный capture добавляет поздний file до удаления history', async () => {
    await seedDeletedAccount({
      userId: USER, deletionId: DELETION_ID,
      hash: 'HASH-CANARY', email: 'deleted@example.test', phone: '79990000001',
    });
    await seedHistory(USER, `[file](${FILE_URL})\n${PERSONAL_CANARY}`);
    await seedCoreJob(USER, DELETION_ID, 'account.core.immediate');
    const { jobs, adapter, neo4j } = makeStack();
    const coreImmediateJob = await claimCoreJob(jobs, DELETION_ID);

    await adapter.execute(coreImmediateJob, makeCtx(jobs));

    const ref = await rows(
      `SELECT resource_key, phase, payload_jsonb, next_attempt_at
         FROM account_deletion_jobs WHERE resource_type='chat-file.purge'`);
    expect(ref).toHaveLength(1);
    expect(ref[0].phase).toBe('purge');
    expect(ref[0].resource_key).toBe(deletionResourceHash(BUCKET, FILE_KEY));
    // Сырой ключ в payload запрещён (fail-closed sanitizer) — только base64url.
    expect(ref[0].payload_jsonb).toEqual({ bucket: BUCKET, key: FILE_KEY_B64 });
    // Purge откладывается на retention от deleted_at.
    expect(new Date(ref[0].next_attempt_at).getTime())
      .toBe(DELETED_AT.getTime() + ACCOUNT_DELETION_RETENTION_MS);
    expect(await historyCount(USER)).toBe(0);
    const payloadJson = JSON.stringify(ref[0].payload_jsonb);
    expect(payloadJson).not.toContain(PERSONAL_CANARY);
    expect(payloadJson).not.toContain(USER);
    expect(neo4j.deleteUserGraphStrict).toHaveBeenCalledWith(USER);
  });

  it('reactivation между graph и local delete отменяет finalize', async () => {
    await seedDeletedAccount({ userId: USER, deletionId: DELETION_ID, hash: 'HASH-CANARY' });
    await seedHistory(USER, PERSONAL_CANARY);
    await seedIdentity(USER, 'email', 'deleted@example.test');
    await seedCoreJob(USER, DELETION_ID, 'account.core.immediate');
    const { jobs, adapter, neo4j } = makeStack();
    const coreImmediateJob = await claimCoreJob(jobs, DELETION_ID);
    neo4j.deleteUserGraphStrict.mockImplementation(async () => {
      await reactivate(USER, NEW_DELETION_ID);
    });

    await expect(adapter.execute(coreImmediateJob, makeCtx(jobs)))
      .rejects.toMatchObject({ kind: 'cancelled' });

    expect(await historyCount(USER)).toBe(1);
    expect(await identityCount(USER)).toBe(1);
    // Новое поколение не задето: строка жива и активна.
    const u = await rows(
      `SELECT state, deletion_id FROM user_id WHERE internal_id=$1`, [USER]);
    expect(u[0]).toMatchObject({ state: 'active', deletion_id: NEW_DELETION_ID });
  });

  it('explicit core immediate очищает полный срез, finance/security logs сохраняются', async () => {
    await seedDeletedAccount({
      userId: USER, deletionId: DELETION_ID,
      hash: 'HASH-CANARY', email: 'deleted@example.test', phone: '79990000001',
      // T17-M6: contacts — мёртвая колонка (writer'ов в дереве нет), но план
      // требует очистки; канарейка проверяет, что она не переживает tombstone.
      contacts: JSON.stringify({ vk: 'КАНАРЕЙКА-КОНТАКТ' }),
    });
    await seedActiveAccount(OTHER);
    // История: своя (file + canary), своя вторая, префикс-коллизия, чужая.
    await seedHistory(USER, `[file](${FILE_URL})\n${PERSONAL_CANARY}`);
    await seedHistory(USER, 'просто реплика');
    await seedHistory(COLLISION, 'COLLISION-CONTENT');
    await seedHistory(OTHER, 'чужая реплика');
    await pool.query(
      `INSERT INTO action_plans (user_id, session_id, assistant_id, title, summary, items)
       VALUES ($1,$2,'a1','план','резюме','[]'::jsonb)`,
      [USER, `${USER}_12`],
    );
    await pool.query(
      `INSERT INTO action_plans (user_id, session_id, assistant_id, title, summary, items)
       VALUES ($1,$2,'a1','чужой план','чужое резюме','[]'::jsonb)`,
      [OTHER, `${OTHER}_12`],
    );
    // Точки «Чистого листа»: своя, чужая и префикс-коллизия (у точек
    // точный user_id, но коллизия страхует от перехода на LIKE).
    await seedContextReset(USER);
    await seedContextReset(OTHER);
    await seedContextReset(COLLISION);
    await pool.query(
      `INSERT INTO ai_profiles_consolidated
         (user_id, preferred_agent, isadmin, tokens, email, profile_data)
       VALUES ($1,'agent-x',true,12345,'deleted@example.test',$2::jsonb)`,
      [USER, JSON.stringify({
        name: PROFILE_CANARY,
        business: { what: { value: 'студия маникюра' } },
      })],
    );
    await pool.query(
      `INSERT INTO ai_profiles_consolidated (user_id, tokens, profile_data)
       VALUES ($1,777,'{}'::jsonb)`,
      [OTHER],
    );
    await seedIdentity(USER, 'email', 'deleted@example.test');
    await seedIdentity(USER, 'phone', '79990000001');
    await seedIdentity(OTHER, 'email', 'other@example.test');
    await pool.query(
      `INSERT INTO tg_user_identities (linkeon_user_id, tg_user_id) VALUES ($1,4242)`,
      [USER],
    );
    await pool.query(
      `INSERT INTO tg_user_identities (linkeon_user_id, tg_user_id) VALUES ($1,4343)`,
      [OTHER],
    );
    await pool.query(
      `INSERT INTO payments (user_id, payment_id, amount, tokens, status)
       VALUES ($1,'pay-fake-1',1990,50000,'succeeded')`,
      [USER],
    );
    await pool.query(
      `INSERT INTO token_transactions (user_id, transaction_type, amount, balance_after, description)
       VALUES ($1,'purchase',50000,50000,'ledger stays')`,
      [USER],
    );
    await pool.query(
      `INSERT INTO login_history (user_id, session_id, device_id, device_description, ip_address)
       VALUES (424242,'sess-fake','dev-fake','fake device','203.0.113.7')`,
    );
    const preservedBefore = await preservedSnapshot();
    await seedCoreJob(USER, DELETION_ID, 'account.core.immediate');
    const { jobs, adapter, neo4j } = makeStack();
    const coreImmediateJob = await claimCoreJob(jobs, DELETION_ID);

    await adapter.execute(coreImmediateJob, makeCtx(jobs));

    // История: своя стерта, коллизия и чужая целы.
    expect(await historyCount(USER)).toBe(0);
    expect(await rows(
      `SELECT session_id FROM custom_chat_history ORDER BY session_id`))
      .toEqual([{ session_id: `${COLLISION}_12` }, { session_id: `${OTHER}_12` }]);
    // Action plans.
    expect(await rows(`SELECT user_id FROM action_plans`))
      .toEqual([{ user_id: OTHER }]);
    // Точки «Чистого листа»: своя стёрта, чужая и коллизия на месте.
    expect(await contextResetCount(USER)).toBe(0);
    expect(await contextResetCount(OTHER)).toBe(1);
    expect(await contextResetCount(COLLISION)).toBe(1);
    // Профиль: строка-оболочка остаётся (surrogate id — lifecycle/billing
    // shell; от неё зависит contacts.purge), содержимое вычищено.
    const prof = await rows(
      `SELECT id, user_id, profile_data, email, preferred_agent, isadmin, tokens
         FROM ai_profiles_consolidated WHERE user_id=$1`, [USER]);
    expect(prof).toHaveLength(1);
    expect(prof[0].id).not.toBeNull();
    expect(prof[0].profile_data).toEqual({});
    expect(prof[0].email).toBeNull();
    expect(prof[0].preferred_agent).toBeNull();
    expect(prof[0].isadmin).toBe(false);
    expect(Number(prof[0].tokens)).toBe(0);
    const otherProf = await rows(
      `SELECT tokens FROM ai_profiles_consolidated WHERE user_id=$1`, [OTHER]);
    expect(Number(otherProf[0].tokens)).toBe(777);
    // Связки входа.
    expect(await identityCount(USER)).toBe(0);
    expect(await identityCount(OTHER)).toBe(1);
    expect(await rows(`SELECT linkeon_user_id FROM tg_user_identities`))
      .toEqual([{ linkeon_user_id: OTHER }]);
    // user_id — tombstone: state/deletion_id/deleted_at не тронуты,
    // password/email/contacts погашены. welcome_bonus_at сохранён (T20-M1):
    // бонус один раз на аккаунт, повторная регистрация его не получает.
    const u = await rows(
      `SELECT state, deletion_id, deleted_at, password_hash, primary_email,
              contacts, welcome_bonus_at, update_date
         FROM user_id WHERE internal_id=$1`, [USER]);
    expect(u[0]).toMatchObject({
      state: 'deleted',
      deletion_id: DELETION_ID,
      password_hash: null,
      primary_email: null,
      contacts: null,
    });
    expect(new Date(u[0].deleted_at).getTime()).toBe(DELETED_AT.getTime());
    expect(u[0].welcome_bonus_at).not.toBeNull();
    expect(new Date(u[0].welcome_bonus_at).getTime()).toBe(DELETED_AT.getTime());
    expect(u[0].update_date).not.toBeNull();
    // Finance/security logs — байт-в-байт.
    expect(await preservedSnapshot()).toBe(preservedBefore);
    // Jobs остаются как audit; core job адаптер сам не закрывает (это делает runner).
    const auditJobs = await rows(
      `SELECT resource_type, status FROM account_deletion_jobs
        WHERE deletion_id=$1 ORDER BY resource_type`, [DELETION_ID]);
    expect(auditJobs).toEqual(
      expect.arrayContaining([
        { resource_type: 'account.core.immediate', status: 'running' },
        { resource_type: 'chat-file.purge', status: 'pending' },
      ]),
    );
    expect(neo4j.deleteUserGraphStrict).toHaveBeenCalledWith(USER);
    // Канарейки: личный текст не пережил удаление нигде, кроме сохранённых
    // logs (их срез сверен выше отдельно).
    const allPayloads = JSON.stringify(await rows(`SELECT payload_jsonb FROM account_deletion_jobs`));
    expect(allPayloads).not.toContain(PERSONAL_CANARY);
    const remainingHistory = JSON.stringify(await rows(`SELECT content FROM custom_chat_history`));
    expect(remainingHistory).not.toContain(PERSONAL_CANARY);
    expect(JSON.stringify(prof[0].profile_data)).not.toContain(PROFILE_CANARY);
  });

  it('merge core purge не трогает identities, перенесённые survivor-у', async () => {
    await seedActiveAccount(SURVIVOR);
    await seedDeletedAccount({ userId: LOSER, deletionId: MERGE_DELETION_ID, hash: 'HASH-CANARY' });
    // Task 19 (stop-фаза merge) уже перенёс связку входа survivor-у.
    await seedIdentity(LOSER, 'email', 'shared@example.test');
    await pool.query(
      `UPDATE user_identities SET user_id=$1 WHERE user_id=$2`,
      [SURVIVOR, LOSER],
    );
    await pool.query(
      `INSERT INTO ai_profiles_consolidated (user_id, tokens, profile_data)
       VALUES ($1,900,'{}'::jsonb)`, [SURVIVOR]);
    await pool.query(
      `INSERT INTO ai_profiles_consolidated (user_id, tokens, email, profile_data)
       VALUES ($1,500,'loser@example.test',$2::jsonb)`,
      [LOSER, JSON.stringify({ name: PROFILE_CANARY })]);
    await seedHistory(LOSER, PERSONAL_CANARY);
    await seedHistory(SURVIVOR, 'реплика survivor');
    await pool.query(
      `INSERT INTO tg_user_identities (linkeon_user_id, tg_user_id) VALUES ($1,4545)`,
      [LOSER],
    );
    await seedCoreJob(LOSER, MERGE_DELETION_ID, 'account.core.purge');
    const { jobs, adapter } = makeStack();
    const corePurgeJob = await claimCoreJob(jobs, MERGE_DELETION_ID);
    expect(corePurgeJob.resourceType).toBe('account.core.purge');

    await adapter.execute(corePurgeJob, makeCtx(jobs));

    // Перенесённая связка survivor'а цела.
    expect(await rows(
      `SELECT user_id, provider_sub FROM user_identities`))
      .toEqual([{ user_id: SURVIVOR, provider_sub: 'shared@example.test' }]);
    // Survivor не задет.
    expect(await historyCount(SURVIVOR)).toBe(1);
    const survivorProf = await rows(
      `SELECT tokens FROM ai_profiles_consolidated WHERE user_id=$1`, [SURVIVOR]);
    expect(Number(survivorProf[0].tokens)).toBe(900);
    const survivor = await rows(
      `SELECT state, deletion_id FROM user_id WHERE internal_id=$1`, [SURVIVOR]);
    expect(survivor[0]).toMatchObject({ state: 'active', deletion_id: null });
    // Loser очищен и остался tombstone своего поколения.
    expect(await historyCount(LOSER)).toBe(0);
    const loserProf = await rows(
      `SELECT profile_data, tokens, email FROM ai_profiles_consolidated WHERE user_id=$1`,
      [LOSER]);
    expect(loserProf[0].profile_data).toEqual({});
    expect(Number(loserProf[0].tokens)).toBe(0);
    expect(loserProf[0].email).toBeNull();
    expect(await rows(`SELECT linkeon_user_id FROM tg_user_identities`)).toEqual([]);
    const loser = await rows(
      `SELECT state, deletion_id, password_hash FROM user_id WHERE internal_id=$1`,
      [LOSER]);
    expect(loser[0]).toMatchObject({
      state: 'deleted', deletion_id: MERGE_DELETION_ID, password_hash: null,
    });
  });

  it('generation mismatch до первого шага — cancelled, данные остались (anti-vacuous)', async () => {
    await seedDeletedAccount({ userId: USER, deletionId: DELETION_ID, hash: 'HASH-CANARY' });
    await seedHistory(USER, PERSONAL_CANARY);
    await seedIdentity(USER, 'email', 'deleted@example.test');
    await pool.query(
      `INSERT INTO ai_profiles_consolidated (user_id, tokens, profile_data)
       VALUES ($1,12345,'{}'::jsonb)`, [USER]);
    await seedCoreJob(USER, DELETION_ID, 'account.core.immediate');
    const { jobs, adapter, neo4j } = makeStack();
    const coreImmediateJob = await claimCoreJob(jobs, DELETION_ID);
    // Реактивация ПОСЛЕ claim, ДО execute.
    await reactivate(USER, NEW_DELETION_ID);

    await expect(adapter.execute(coreImmediateJob, makeCtx(jobs)))
      .rejects.toBeInstanceOf(DeletionCancelledError);

    expect(await historyCount(USER)).toBe(1);
    expect(await identityCount(USER)).toBe(1);
    const prof = await rows(
      `SELECT tokens FROM ai_profiles_consolidated WHERE user_id=$1`, [USER]);
    expect(Number(prof[0].tokens)).toBe(12345);
    expect(await rows(
      `SELECT count(*)::int AS n FROM account_deletion_jobs WHERE resource_type='chat-file.purge'`))
      .toEqual([{ n: 0 }]);
    expect(neo4j.deleteUserGraphStrict).not.toHaveBeenCalled();
  });

  it('fencing внутри транзакции: flip после graph — lockAndAssertCurrent отменяет и откатывает', async () => {
    await seedDeletedAccount({ userId: USER, deletionId: DELETION_ID, hash: 'HASH-CANARY' });
    await seedHistory(USER, PERSONAL_CANARY);
    await seedContextReset(USER);
    await seedIdentity(USER, 'email', 'deleted@example.test');
    await pool.query(
      `INSERT INTO ai_profiles_consolidated (user_id, tokens, profile_data)
       VALUES ($1,12345,'{}'::jsonb)`, [USER]);
    await seedCoreJob(USER, DELETION_ID, 'account.core.immediate');
    const { jobs, adapter, neo4j } = makeStack();
    const coreImmediateJob = await claimCoreJob(jobs, DELETION_ID);
    // Гонка между ПОСЛЕДНИМ assertCurrent и транзакцией: внешний fencing
    // здесь пропускается (3-й вызов уже после flip), поэтому обязан сработать
    // внутренний — SELECT ... FOR UPDATE + gen-assert внутри tx.
    let asserts = 0;
    const ctx: DeletionExecution = {
      db: { query: (sql: string, params?: unknown[]) => pool.query(sql, params as any[]) },
      assertCurrent: async () => {
        asserts += 1;
        if (asserts === 3) await reactivate(USER, NEW_DELETION_ID);
      },
    };

    await expect(adapter.execute(coreImmediateJob, ctx))
      .rejects.toBeInstanceOf(DeletionCancelledError);

    expect(asserts).toBe(3);
    expect(neo4j.deleteUserGraphStrict).toHaveBeenCalledTimes(1);
    // ROLLBACK: ни одна строка не удалена.
    expect(await historyCount(USER)).toBe(1);
    expect(await contextResetCount(USER)).toBe(1);
    expect(await identityCount(USER)).toBe(1);
    const prof = await rows(
      `SELECT tokens FROM ai_profiles_consolidated WHERE user_id=$1`, [USER]);
    expect(Number(prof[0].tokens)).toBe(12345);
    const u = await rows(
      `SELECT state, deletion_id, password_hash FROM user_id WHERE internal_id=$1`, [USER]);
    expect(u[0]).toMatchObject({
      state: 'active', deletion_id: NEW_DELETION_ID, password_hash: 'HASH-CANARY',
    });
  });

  it('pending stop после recapture — retryable отказ до graph, данные целы', async () => {
    await seedDeletedAccount({ userId: USER, deletionId: DELETION_ID, hash: 'HASH-CANARY' });
    await seedHistory(USER, PERSONAL_CANARY);
    await seedCoreJob(USER, DELETION_ID, 'account.core.immediate');
    const { jobs, adapter, neo4j } = makeStack();
    const coreImmediateJob = await claimCoreJob(jobs, DELETION_ID);
    // Новые stop jobs (например, созданные recapture или поздним планированием)
    // блокируют core dependency: это внутренний порядок, а не отмена поколения.
    await pool.query(
      `INSERT INTO account_deletion_jobs
         (deletion_id, user_id, resource_type, resource_key, phase,
          payload_jsonb, status, next_attempt_at)
       VALUES ($1,$2,'telegram.stop','telegram','immediate','{}'::jsonb,'pending', now())`,
      [DELETION_ID, USER],
    );

    const err = await adapter.execute(coreImmediateJob, makeCtx(jobs)).catch((e) => e);

    expect(err).toBeInstanceOf(DeletionRetryError);
    expect(err).toMatchObject({ kind: 'db' });
    expect(neo4j.deleteUserGraphStrict).not.toHaveBeenCalled();
    expect(await historyCount(USER)).toBe(1);
  });

  it('идемпотентность: повторный execute — тот же срез, один chat-file job', async () => {
    await seedDeletedAccount({ userId: USER, deletionId: DELETION_ID, hash: 'HASH-CANARY' });
    await seedHistory(USER, `[file](${FILE_URL})\n${PERSONAL_CANARY}`);
    await seedCoreJob(USER, DELETION_ID, 'account.core.immediate');
    const { jobs, adapter } = makeStack();
    const coreImmediateJob = await claimCoreJob(jobs, DELETION_ID);

    await adapter.execute(coreImmediateJob, makeCtx(jobs));
    const firstJobs = JSON.stringify(await rows(
      `SELECT resource_type, resource_key, phase, payload_jsonb
         FROM account_deletion_jobs ORDER BY resource_type`));
    // Повтор тем же leased job (lease жив): recapture на пустой истории
    // ничего не добавляет, ON CONFLICT дедуплицирует, deletes — no-op.
    await expect(adapter.execute(coreImmediateJob, makeCtx(jobs))).resolves.toBeUndefined();

    expect(JSON.stringify(await rows(
      `SELECT resource_type, resource_key, phase, payload_jsonb
         FROM account_deletion_jobs ORDER BY resource_type`))).toBe(firstJobs);
    expect(await rows(
      `SELECT count(*)::int AS n FROM account_deletion_jobs WHERE resource_type='chat-file.purge'`))
      .toEqual([{ n: 1 }]);
    expect(await historyCount(USER)).toBe(0);
  });
});
