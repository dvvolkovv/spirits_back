import { readFileSync } from 'fs';
import { ServiceUnavailableException } from '@nestjs/common';
import { Pool } from 'pg';
import { AccountDeletionJobs } from '../account-deletion/account-deletion.jobs';
import { AccountDeletionLifecycle } from '../account-deletion/account-deletion.lifecycle';
import { AccountDeletionPlanner } from '../account-deletion/account-deletion.planner';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import { AccountDeletionRunner } from '../account-deletion/account-deletion.runner';
import { DeletionCancelledError } from '../account-deletion/account-deletion.safe';
import type {
  DeletionDiscoverer,
  DeletionExecution,
  DeletionJobRow,
  DeletionResourceType,
} from '../account-deletion/account-deletion.types';
import type { ExtractEnv } from '../chat/chat-files/extract';
import { ProfileAccountDeletionAdapter } from '../profile/profile-account-deletion.adapter';
import { ProfileAccountDeletionRecapture } from '../profile/profile-account-deletion.discovery';
import { ProfileService } from '../profile/profile.service';
import { IdentityService, WELCOME_BONUS } from './identity.service';
import type { ResolveResult } from './identity.types';

/**
 * Task 20 — реактивация удалённого аккаунта против настоящей Postgres.
 *
 * Регистрация тем же номером после удаления попадает в ту же строку user_id
 * (internal_id телефонного входа — сам номер). До Task 20 реактивационный
 * UPDATE шёл отдельными запросами через пул и только переводил state в
 * 'active': задачи старого поколения удаления оставались живыми (stale
 * worker мог продолжить стирание «воскресшего» аккаунта), а deletion_id/
 * deleted_at продолжали указывать на удалённое поколение.
 *
 * Контур: НАСТОЯЩИЕ IdentityService.resolveOrCreate, ProfileService.
 * deleteProfile → AccountDeletionLifecycle.deleteExplicit, Jobs/Runner/
 * Planner и core-адаптер — против живой БД. Фейки только на внешних
 * границах (прецедент — identity.merge-deletion.pg.spec.ts и
 * profile-deletion.lifecycle.pg.spec.ts):
 *  - FakeRegistry: журнал вызовов + делегация core настоящему адаптеру;
 *  - один фейковый стоп-discoverer (routine.stop);
 *  - neo4j — jest.fn.
 *
 * Сценарии плана:
 *  1. полный цикл: resolvePhone → deleteProfile → insertJob(old.deletion_id,
 *     'running') → resolvePhone снова: тот же internal_id, строка active без
 *     deletion_id/deleted_at, незавершённых задач старого поколения нет,
 *     stale-задача cancelled (assertCurrent → kind 'cancelled'), ресурсы
 *     нового аккаунта в единственном экземпляре; приветственный бонус
 *     НЕ выдан повторно (T20-M1: tombstone сохраняет welcome_bonus_at);
 *  2. historical deleted (deletion_id NULL) — реактивация без задач,
 *     coordinator такое не подбирает;
 *  3. повторное удаление после реактивации — НОВЫЙ UUID поколения.
 *
 * T20-M1 (отдельный describe ниже): issueWelcomeBonus сверяется с журналом
 * token_transactions, если отметка welcome_bonus_at пуста.
 */

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `identity_reactivation_spec_${process.pid}`;

const PERSONAL_CANARY = 'ЛИЧНЫЙ-ТЕКСТ';
const TEST_ENV: ExtractEnv = {
  publicBaseUrl: 'https://minio.test',
  agentUrl: 'https://agent.test',
  backendUrl: 'https://backend.test',
};
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const STOP_TYPE: DeletionResourceType = 'routine.stop';
const STALE_TYPE: DeletionResourceType = 'events.purge';

jest.setTimeout(60_000);

maybe('реактивация после удаления — одна транзакция, отмена старых задач (Task 20, PG)', () => {
  let pool: Pool;
  let admin: Pool;
  let origBucketEnv: string | undefined;

  const db = {
    query: (sql: string, params?: any[]) => pool.query(sql, params as any[]),
    getClient: () => pool.connect(),
  };

  async function rows(sql: string, params: any[] = []): Promise<any[]> {
    return (await pool.query(sql, params)).rows;
  }

  /** resolveOrCreate отдаёт union — в этих сценариях всегда ok. */
  function ok(r: ResolveResult): Extract<ResolveResult, { status: 'ok' }> {
    if (r.status !== 'ok') throw new Error(`ожидался ok, получен ${r.status}`);
    return r as Extract<ResolveResult, { status: 'ok' }>;
  }

  async function userRow(userId: string) {
    const r = await rows(
      `SELECT state, deletion_id, deleted_at, welcome_bonus_at, password_hash
       FROM user_id WHERE internal_id=$1`,
      [userId],
    );
    return r[0];
  }

  async function unfinishedJobs(deletionId: string): Promise<number> {
    const r = await rows(
      `SELECT count(*)::int AS n FROM account_deletion_jobs
        WHERE deletion_id=$1 AND status IN ('pending','running','failed')`,
      [deletionId],
    );
    return r[0].n;
  }

  async function jobRowById(id: string) {
    const r = await rows(
      `SELECT status, lease_until, completed_at FROM account_deletion_jobs WHERE id=$1`,
      [id],
    );
    return r[0];
  }

  async function jobCount(): Promise<number> {
    const r = await rows(`SELECT count(*)::int AS n FROM account_deletion_jobs`);
    return r[0].n;
  }

  /**
   * Поколение core-задачи пользователя: после реактивации user_id.deletion_id
   * уже NULL, а аудит-строка задачи остаётся (таблица в beforeEach TRUNCATE-
   * ится, поэтому core.immediate у пользователя ровно один).
   */
  async function generationOfCore(userId: string): Promise<string> {
    const r = await rows(
      `SELECT deletion_id FROM account_deletion_jobs
        WHERE user_id=$1 AND resource_type='account.core.immediate'`,
      [userId],
    );
    return r[0].deletion_id;
  }

  /**
   * Суммы записей «Приветственный бонус» в журнале, по времени. Подпись —
   * литералом: это контракт с историей операций, а не деталь реализации.
   */
  async function welcomeCredits(userId: string): Promise<number[]> {
    const r = await rows(
      `SELECT amount FROM token_transactions
        WHERE user_id=$1 AND transaction_type='bonus'
          AND description='Приветственный бонус'
        ORDER BY created_at`,
      [userId],
    );
    return r.map((x) => Number(x.amount));
  }

  async function balance(userId: string): Promise<number> {
    const r = await rows(
      `SELECT tokens FROM ai_profiles_consolidated WHERE user_id=$1`,
      [userId],
    );
    return Number(r[0]?.tokens ?? 0);
  }

  /** newAccountResourceCount: профильная строка ровно одна (shell не дублируется). */
  async function profileRowCount(userId: string): Promise<number> {
    const r = await rows(
      `SELECT count(*)::int AS n FROM ai_profiles_consolidated WHERE user_id=$1`,
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

  async function historyCount(userId: string): Promise<number> {
    const r = await rows(
      `SELECT count(*)::int AS n FROM custom_chat_history
        WHERE session_id LIKE $1 || '\\_%' ESCAPE '\\'`,
      [userId],
    );
    return r[0].n;
  }

  async function seedHistory(userId: string, content: string): Promise<void> {
    await pool.query(
      `INSERT INTO custom_chat_history (session_id, sender_type, content)
       VALUES ($1 || '_1', 'human', $2)`,
      [userId, content],
    );
  }

  /**
   * Задача старого поколения, которую «исполняет» сторонний worker: running,
   * attempts=1, живой lease. Вставляется напрямую (фаза purge — claimNextStop
   * её не касается, а claimNext воркера в этом спек не работает).
   */
  async function insertRunningJob(
    jobs: AccountDeletionJobs,
    userId: string,
    deletionId: string,
  ): Promise<DeletionJobRow> {
    await pool.query(
      `INSERT INTO account_deletion_jobs
        (deletion_id,user_id,resource_type,resource_key,phase,payload_jsonb,
         status,attempts,lease_until,next_attempt_at)
       VALUES ($1,$2,$3,'events','purge','{}'::jsonb,
               'running',1, now() + interval '5 minutes', now())`,
      [deletionId, userId, STALE_TYPE],
    );
    return jobs.find(deletionId, STALE_TYPE, 'events');
  }

  /** Журнал вызовов + делегация core настоящему адаптеру (прецедент Task 18). */
  class FakeRegistry {
    private core: ProfileAccountDeletionAdapter | null = null;

    constructor(readonly calls: string[]) {}

    setCore(adapter: ProfileAccountDeletionAdapter): void {
      this.core = adapter;
    }

    assertReady(): void {}

    getExecutor(resourceType: DeletionResourceType) {
      return {
        resourceTypes: [resourceType],
        execute: async (job: DeletionJobRow, ctx: DeletionExecution) => {
          this.calls.push(
            resourceType === 'account.core.immediate' ? 'core.immediate' : resourceType,
          );
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
    jobs: [{
      resourceType: STOP_TYPE,
      resourceKey: 'routine',
      phase: 'immediate',
      payload: {},
    }],
    skips: [],
  });

  function makeStack() {
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
    const planner = new AccountDeletionPlanner([stopDiscoverer]);
    const lifecycle = new AccountDeletionLifecycle(
      db as any,
      planner as any,
      jobs,
      registry as any,
      runner,
    );
    const profile = new ProfileService(db as any, lifecycle);
    // Lifecycle отдаётся IdentityService через фейковый ModuleRef — как в
    // identity.merge-deletion.pg.spec.ts (DI без Nest-контейнера).
    const moduleRef = { get: () => lifecycle };
    const identity = new IdentityService(db as any, undefined, undefined, moduleRef as any);
    return { calls, jobs, registry, runner, lifecycle, profile, identity, neo4j };
  }

  beforeAll(async () => {
    origBucketEnv = process.env.MINIO_BUCKET_CHAT_FILES;
    process.env.MINIO_BUCKET_CHAT_FILES = 'linkeon-chat-files';

    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 2, options: `-c search_path=${SCHEMA}` });

    // transaction_type_enum — дословно 001_core_schema.sql: нужен
    // token_transactions и add_user_tokens (бонус пишет 'bonus').
    await pool.query(`
      CREATE TYPE transaction_type_enum AS ENUM (
          'purchase',
          'consumed',
          'bonus',
          'refund',
          'adjustment',
          'coupon'
      );
    `);

    // user_id — дословно 001_core_schema.sql + UNIQUE(internal_id).
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

    // custom_chat_history — дословно 001_core_schema.sql + seq + default.
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

    // action_plans — настоящая миграция модуля (core стирает и её).
    await pool.query(readFileSync('src/chat/action-plans/migrations/001_action_plans.sql', 'utf8'));
    // chat_context_resets — точки «Чистого листа» (core стирает и их).
    await pool.query(readFileSync('src/chat/context-reset/migrations/001_chat_context_resets.sql', 'utf8'));

    // ai_profiles_consolidated — дословно 001_core_schema.sql + seq + UNIQUE.
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

    // token_transactions — дословно 001_core_schema.sql: сюда пишет add_user_tokens.
    await pool.query(`
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
    `);

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

    // add_user_tokens — дословно tokens/migrations/001_add_user_tokens_lock.sql
    // без схемы-квалификации: приветственный бонус идёт через неё.
    await pool.query(`
      CREATE OR REPLACE FUNCTION add_user_tokens(
          p_user_id text,
          p_amount bigint,
          p_transaction_type transaction_type_enum,
          p_description text DEFAULT NULL,
          p_metadata jsonb DEFAULT NULL
      ) RETURNS json
      LANGUAGE plpgsql
      AS $$
      DECLARE
          v_previous_balance BIGINT;
          v_new_balance BIGINT;
          v_transaction_id UUID;
      BEGIN
          SELECT COALESCE(tokens, 0) INTO v_previous_balance
          FROM ai_profiles_consolidated
          WHERE user_id = p_user_id
          FOR UPDATE;

          IF v_previous_balance IS NULL THEN
              v_previous_balance := 0;
              v_new_balance := GREATEST(0, p_amount);
          ELSE
              v_new_balance := GREATEST(0, v_previous_balance + p_amount);
          END IF;

          UPDATE ai_profiles_consolidated
          SET tokens = v_new_balance
          WHERE user_id = p_user_id;

          INSERT INTO token_transactions (
              id,
              user_id,
              transaction_type,
              amount,
              balance_after,
              description,
              metadata
          )
          VALUES (
              gen_random_uuid(),
              p_user_id,
              p_transaction_type,
              p_amount,
              v_new_balance,
              p_description,
              p_metadata
          )
          RETURNING id INTO v_transaction_id;

          RETURN json_build_object(
              'success', true,
              'transaction_id', v_transaction_id,
              'previous_balance', v_previous_balance,
              'new_balance', v_new_balance,
              'tokens_added', p_amount
          );
      END;
      $$;
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
                ai_profiles_consolidated, token_transactions, user_identities,
                tg_user_identities, user_id`,
    );
  });

  it('регистрация тем же номером после удаления: тот же аккаунт active, старая generation снята, stale-задача cancelled', async () => {
    const PHONE = '79990000101';
    const stack = makeStack();

    const first = ok(await stack.identity.resolveOrCreate('phone', { phone: PHONE }));
    expect(first.isNew).toBe(true);
    // Создание: ровно одна запись «Приветственный бонус» на 25 000.
    const bonusMark = (await userRow(first.userId)).welcome_bonus_at;
    expect(bonusMark).not.toBeNull();
    expect(await welcomeCredits(first.userId)).toEqual([WELCOME_BONUS]);
    expect(await balance(first.userId)).toBe(WELCOME_BONUS);
    await seedHistory(first.userId, PERSONAL_CANARY);

    // Явное удаление: поколение G1, стопы и core исполнены синхронно.
    await stack.profile.deleteProfile(first.userId);
    const deleted = await userRow(first.userId);
    expect(deleted.state).toBe('deleted');
    const generation1 = deleted.deletion_id;
    expect(generation1).toMatch(UUID_RE);
    expect(await historyCount(first.userId)).toBe(0);

    // Сторонний worker «исполняет» purge-задачу старого поколения.
    const staleJob = await insertRunningJob(stack.jobs, first.userId, generation1);
    expect(staleJob.status).toBe('running');

    // Повторная регистрация тем же номером — реактивация.
    const second = ok(await stack.identity.resolveOrCreate('phone', { phone: PHONE }));
    expect(second.userId).toBe(first.userId);

    const u = await userRow(first.userId);
    expect(u.state).toBe('active');
    expect(u.deleted_at).toBeNull();
    expect(u.deletion_id).toBeNull();

    // Незавершённых задач старого поколения нет; stale-задача снята с lease.
    expect(await unfinishedJobs(generation1)).toBe(0);
    const staleRow = await jobRowById(staleJob.id);
    expect(staleRow.status).toBe('cancelled');
    expect(staleRow.lease_until).toBeNull();
    expect(staleRow.completed_at).not.toBeNull();

    // Fencing по снимку задачи, сделанному до реактивации: worker обязан
    // получить отмену, а не продолжить стирание.
    await expect(stack.jobs.assertCurrent(staleJob))
      .rejects.toBeInstanceOf(DeletionCancelledError);
    await expect(stack.jobs.assertCurrent(staleJob))
      .rejects.toMatchObject({ kind: 'cancelled' });

    // Ресурсы нового аккаунта в единственном экземпляре: профильная строка
    // (shell) не задвоена, связка входа одна.
    expect(await profileRowCount(first.userId)).toBe(1);
    expect(await identityCount(first.userId)).toBe(1);

    // T20-M1: бонус НЕ выдан заново. Отметка пережила удаление (tombstone её
    // не сбрасывает), в журнале по-прежнему одна запись «Приветственный
    // бонус», баланс вернувшегося не вырос на 25 000. История не воскресла.
    expect(u.welcome_bonus_at).not.toBeNull();
    expect(new Date(u.welcome_bonus_at).getTime()).toBe(new Date(bonusMark).getTime());
    expect(await welcomeCredits(first.userId)).toEqual([WELCOME_BONUS]);
    expect(await balance(first.userId)).toBe(0);
    expect(await historyCount(first.userId)).toBe(0);
  });

  it('historical deleted без поколения — реактивация без задач, coordinator не подбирает', async () => {
    const PHONE = '79990000102';
    // Удалён ДО введения pipeline: state='deleted', deletion_id NULL.
    // welcome_bonus_at сохранён (tombstone не выполнялся) — бонус не переиздаётся.
    await pool.query(
      `INSERT INTO user_id (internal_id, primary_phone, state, deleted_at, welcome_bonus_at)
       VALUES ($1,$2,'deleted', now() - interval '400 days', now() - interval '500 days')`,
      [PHONE, PHONE],
    );
    await pool.query(
      `INSERT INTO ai_profiles_consolidated (user_id, tokens) VALUES ($1, 0)`,
      [PHONE],
    );
    const stack = makeStack();

    const r = ok(await stack.identity.resolveOrCreate('phone', { phone: PHONE }));
    expect(r.userId).toBe(PHONE);

    const u = await userRow(PHONE);
    expect(u.state).toBe('active');
    expect(u.deletion_id).toBeNull();
    expect(u.deleted_at).toBeNull();
    // Задач не появилось вовсе; coordinator (dueAccounts) нечего подбирать.
    expect(await jobCount()).toBe(0);
    expect(await stack.jobs.dueAccounts(null)).toEqual([]);
    // Бонус не задвоен: маркер уже стоял — claim вернул 0 строк.
    expect(await balance(PHONE)).toBe(0);
    expect(await profileRowCount(PHONE)).toBe(1);
    expect(await identityCount(PHONE)).toBe(1);
  });

  it('повторное удаление после реактивации — НОВЫЙ UUID поколения', async () => {
    const PHONE = '79990000103';
    const stack = makeStack();

    const first = ok(await stack.identity.resolveOrCreate('phone', { phone: PHONE }));
    await stack.profile.deleteProfile(first.userId);
    const generation1 = (await userRow(first.userId)).deletion_id;
    expect(generation1).toMatch(UUID_RE);

    ok(await stack.identity.resolveOrCreate('phone', { phone: PHONE }));
    // Реактивация сняла старое поколение целиком — до следующего удаления.
    const mid = await userRow(first.userId);
    expect(mid.state).toBe('active');
    expect(mid.deletion_id).toBeNull();
    expect(mid.deleted_at).toBeNull();

    await seedHistory(first.userId, PERSONAL_CANARY);
    await stack.profile.deleteProfile(first.userId);

    const after = await userRow(first.userId);
    expect(after.state).toBe('deleted');
    expect(after.deletion_id).toMatch(UUID_RE);
    expect(after.deletion_id).not.toBe(generation1);
    expect(after.deleted_at).not.toBeNull();
    // Данные нового аккаунта стёрты уже вторым удалением.
    expect(await historyCount(first.userId)).toBe(0);
    expect(await unfinishedJobs(after.deletion_id)).toBe(0);
    // Старое поколение осталось в архиве задач (аудит) и не пересоздавалось.
    expect(await unfinishedJobs(generation1)).toBe(0);
  });

  /**
   * T20-M3 (ревью Task 20): реактивация ВО ВРЕМЯ исполнения core-адаптера —
   * движковый аналог flip-теста Task 19 (identity.merge-deletion.pg.spec.ts
   * «реактивация во время стопа»), но на явном пути и в окне ПОСЛЕ внешних
   * операций.
   *
   * Hook внутри neo4j.deleteUserGraphStrict (единственная внешняя операция
   * core) воспроизводит ТОЧНЫЙ эффект IdentityService.reactivateIfNeeded
   * (отмена незавершённых задач поколения + снятие поколения) прямым SQL в
   * одной транзакции — прецедент identity.merge-deletion.pg.spec.ts (helper
   * reactivate). Вход через resolveOrCreate здесь недостижим: его шаг 1
   * возвращает существующую связку user_identities БЕЗ проверки state, а
   * связки core стирает только в самом конце (локальная транзакция) — до
   * неё повторная регистрация «входит» в удалённый аккаунт, а не
   * реактивирует его (наблюдение для координатора, вне рамок Task 21).
   *
   * Следующий за neo4j assertCurrent (profile-account-deletion.adapter.ts,
   * перед локальной транзакцией) обязан увидеть снятое поколение и бросить
   * DeletionCancelledError: локальные удаления НЕ переживают реактивацию,
   * job остаётся cancelled (поздний jobs.fail не воскрешает строку —
   * WHERE status='running' даёт 0 строк), HTTP-исход deleteExplicit —
   * прежний 503 (lifecycle измеряет успех статусом строки core).
   * Per-batch gen-recheck в адаптерах НЕ добавляется (решение ревью).
   */
  it('T20-M3: реактивация во время core-адаптера — локальное стирание не выживает, core cancelled, аккаунт жив', async () => {
    const PHONE = '79990000104';
    const stack = makeStack();

    const first = ok(await stack.identity.resolveOrCreate('phone', { phone: PHONE }));
    await seedHistory(first.userId, PERSONAL_CANARY);

    // Реактивация попадает ровно между внешней операцией (neo4j) и локальной
    // транзакцией удаления — самое опасное окно flip-гонки.
    stack.neo4j.deleteUserGraphStrict.mockImplementation(async () => {
      const gen = await rows(
        `SELECT deletion_id FROM user_id WHERE internal_id=$1`,
        [first.userId],
      );
      const deletionId = gen[0].deletion_id;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Шаг 2 reactivateIfNeeded: гасим ВСЕ незавершённые задачи поколения.
        await client.query(
          `UPDATE account_deletion_jobs
              SET status='cancelled', lease_until=NULL,
                  completed_at=now(), updated_at=now()
            WHERE user_id=$1 AND deletion_id=$2
              AND status IN ('pending','running','failed')`,
          [first.userId, deletionId],
        );
        // Шаг 3: снимаем поколение.
        await client.query(
          `UPDATE user_id
              SET state='active', deleted_at=NULL, deletion_id=NULL, update_date=now()
            WHERE internal_id=$1 AND state <> 'active'`,
          [first.userId],
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    });

    await expect(stack.profile.deleteProfile(first.userId))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(stack.neo4j.deleteUserGraphStrict).toHaveBeenCalled();

    // Записи адаптера не переживают реактивацию: личный текст цел (локальная
    // транзакция core не начиналась — assertCurrent прервал исполнение).
    expect(await historyCount(first.userId)).toBeGreaterThan(0);

    // Аккаунт снова жив: поколение снято реактивацией.
    const u = await userRow(first.userId);
    expect(u.state).toBe('active');
    expect(u.deletion_id).toBeNull();
    expect(u.deleted_at).toBeNull();

    // Job остаётся cancelled: реактивация отменила running-строку, а поздний
    // jobs.fail('cancelled') её не изменил (WHERE status='running' — 0 строк).
    const generation1 = await generationOfCore(first.userId);
    const core = await stack.jobs.find(generation1, 'account.core.immediate', 'account');
    expect(core.status).toBe('cancelled');
    expect(core.leaseUntil).toBeNull();
    expect(await unfinishedJobs(generation1)).toBe(0);
  });

  /**
   * T20-M1 — сверка с журналом при пустой отметке welcome_bonus_at.
   *
   * Это страховка: на проде пустые отметки на каждом старте API заполняет
   * 001_identity_init.sql (welcome_bonus_at = create_date), а сверка
   * срабатывает, если эту строку уберут, миграция 001 не пройдёт или у строки
   * create_date IS NULL. Строки здесь сеются с пустой отметкой уже после
   * накатки 001 в beforeAll — проверяется сама сверка. Приветственный бонус
   * остаётся в token_transactions (журнал удаление не трогает) — по нему и
   * видно, что бонус уже выдавался. Фильтр именно по подписи: тип 'bonus'
   * общий с реферальным.
   */
  describe('T20-M1: приветственный бонус сверяется с журналом', () => {
    const REFERRAL_DESCRIPTION = 'Реферальный бонус за регистрацию по приглашению';

    async function seedCredit(
      userId: string,
      amount: number,
      description: string,
      createdAt: string | null,
    ): Promise<void> {
      await pool.query(
        `INSERT INTO token_transactions
           (user_id, transaction_type, amount, balance_after, description, metadata, created_at)
         VALUES ($1, 'bonus', $2, $2, $3, NULL, $4::timestamptz)`,
        [userId, amount, description, createdAt],
      );
    }

    it('(d) отметка NULL, в журнале уже есть «Приветственный бонус» — не выдаётся, отметка = самая ранняя запись', async () => {
      const PHONE = '79990000111';
      // Удалён до T20-M1: tombstone сбросил отметку, и 001_identity_init.sql
      // её не вернул — строку 57 убрали, миграция 001 на старте не прошла или
      // create_date IS NULL (см. докблок issueWelcomeBonus); поколение завершено.
      // Бонусов в журнале два — ферма успела получить его повторно.
      await pool.query(
        `INSERT INTO user_id (internal_id, primary_phone, state, deleted_at, deletion_id, welcome_bonus_at)
         VALUES ($1, $2, 'deleted', now() - interval '30 days', gen_random_uuid(), NULL)`,
        [PHONE, PHONE],
      );
      await pool.query(
        `INSERT INTO ai_profiles_consolidated (user_id, tokens) VALUES ($1, 0)`,
        [PHONE],
      );
      await seedCredit(PHONE, WELCOME_BONUS, 'Приветственный бонус', '2026-03-01T10:00:00.123456Z');
      await seedCredit(PHONE, WELCOME_BONUS, 'Приветственный бонус', '2026-06-01T10:00:00.654321Z');
      const stack = makeStack();

      const r = ok(await stack.identity.resolveOrCreate('phone', { phone: PHONE }));
      expect(r.userId).toBe(PHONE);

      expect((await userRow(PHONE)).state).toBe('active');
      // Новой записи нет, баланс не вырос.
      expect(await welcomeCredits(PHONE)).toEqual([WELCOME_BONUS, WELCOME_BONUS]);
      expect(await balance(PHONE)).toBe(0);
      // Отметка — created_at самой ранней записи, с точностью до микросекунд
      // (не now(): окно рефералки и когорты считают от неё «дату рождения»).
      const mark = await rows(
        `SELECT welcome_bonus_at = '2026-03-01T10:00:00.123456Z'::timestamptz AS same
           FROM user_id WHERE internal_id=$1`,
        [PHONE],
      );
      expect(mark[0].same).toBe(true);
    });

    it('(e) отметка NULL, журнал пуст — бонус выдаётся ровно один раз, повторный вызов no-op', async () => {
      const PHONE = '79990000112';
      await pool.query(
        `INSERT INTO user_id (internal_id, primary_phone, state, welcome_bonus_at)
         VALUES ($1, $2, 'active', NULL)`,
        [PHONE, PHONE],
      );
      const stack = makeStack();

      ok(await stack.identity.resolveOrCreate('phone', { phone: PHONE }));
      expect(await welcomeCredits(PHONE)).toEqual([WELCOME_BONUS]);
      expect(await balance(PHONE)).toBe(WELCOME_BONUS);
      const mark = (await userRow(PHONE)).welcome_bonus_at;
      expect(mark).not.toBeNull();

      // Повторный вызов: отметка стоит — ни записи, ни зачисления.
      await (stack.identity as any).issueWelcomeBonus(db, PHONE);
      expect(await welcomeCredits(PHONE)).toEqual([WELCOME_BONUS]);
      expect(await balance(PHONE)).toBe(WELCOME_BONUS);
      expect(new Date((await userRow(PHONE)).welcome_bonus_at).getTime())
        .toBe(new Date(mark).getTime());
    });

    it('(f) отметка NULL, в журнале только реферальный бонус — приветственный выдаётся', async () => {
      const PHONE = '79990000113';
      await pool.query(
        `INSERT INTO user_id (internal_id, primary_phone, state, welcome_bonus_at)
         VALUES ($1, $2, 'active', NULL)`,
        [PHONE, PHONE],
      );
      await pool.query(
        `INSERT INTO ai_profiles_consolidated (user_id, tokens) VALUES ($1, 5000)`,
        [PHONE],
      );
      // Тот же transaction_type 'bonus', другая подпись.
      await seedCredit(PHONE, 5000, REFERRAL_DESCRIPTION, '2026-03-01T10:00:00Z');
      const stack = makeStack();

      ok(await stack.identity.resolveOrCreate('phone', { phone: PHONE }));
      expect(await welcomeCredits(PHONE)).toEqual([WELCOME_BONUS]);
      expect(await balance(PHONE)).toBe(5000 + WELCOME_BONUS);
      const mark = await rows(
        `SELECT welcome_bonus_at IS NOT NULL AS set,
                welcome_bonus_at <> '2026-03-01T10:00:00Z'::timestamptz AS not_referral
           FROM user_id WHERE internal_id=$1`,
        [PHONE],
      );
      expect(mark[0]).toEqual({ set: true, not_referral: true });
    });

    it('(g) отметка NULL, в журнале «Приветственный бонус» с created_at NULL — не выдаётся, отметка ставится', async () => {
      const PHONE = '79990000114';
      await pool.query(
        `INSERT INTO user_id (internal_id, primary_phone, state, welcome_bonus_at)
         VALUES ($1, $2, 'active', NULL)`,
        [PHONE, PHONE],
      );
      await pool.query(
        `INSERT INTO ai_profiles_consolidated (user_id, tokens) VALUES ($1, 0)`,
        [PHONE],
      );
      // Колонка created_at допускает NULL, а min(created_at) такую запись не
      // видит — запись от этого не перестаёт быть выданным бонусом.
      await seedCredit(PHONE, WELCOME_BONUS, 'Приветственный бонус', null);
      const stack = makeStack();

      ok(await stack.identity.resolveOrCreate('phone', { phone: PHONE }));
      expect(await welcomeCredits(PHONE)).toEqual([WELCOME_BONUS]);
      expect(await balance(PHONE)).toBe(0);
      expect((await userRow(PHONE)).welcome_bonus_at).not.toBeNull();
    });
  });
});
