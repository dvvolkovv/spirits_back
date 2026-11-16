import { readFileSync } from 'fs';
import { Pool } from 'pg';
import { AccountDeletionJobs } from '../account-deletion/account-deletion.jobs';
import { AccountDeletionLifecycle } from '../account-deletion/account-deletion.lifecycle';
import { AccountDeletionPlanner } from '../account-deletion/account-deletion.planner';
import { AccountDeletionRunner } from '../account-deletion/account-deletion.runner';
import {
  ACCOUNT_DELETION_RETENTION_MS,
  DeletionCancelledError,
  DeletionRetryError,
} from '../account-deletion/account-deletion.safe';
import type {
  DeletionDiscoverer,
  DeletionExecution,
  DeletionJobRow,
  DeletionResourceType,
} from '../account-deletion/account-deletion.types';
import { IdentityService } from './identity.service';

/**
 * Task 19 — merge loser против настоящей Postgres: поколение удаления,
 * credit-first баланс, внешние стопы до переноса идентичностей и отложенный
 * core purge (deleted_at + 30 дней).
 *
 * Контур: НАСТОЯЩИЕ AccountDeletionJobs / AccountDeletionRunner /
 * AccountDeletionPlanner / AccountDeletionLifecycle против живой БД; фейки
 * только на внешних границах:
 *  - FakeRegistry вместо AccountDeletionRegistry: один фейковый стоп
 *    integration.apple.stop (в проде его исполняет integration-адаптер,
 *    который и вызывает apple.revokeToken — отдельного вызова apple из
 *    identity.service нет и не должно быть). Исполнитель записывает в журнал
 *    метку 'stop-loser' и наблюдает состояние user_identities/tg на момент
 *    стопа — так доказывается «revoke ДО переноса идентичностей»;
 *  - фейковый discoverer вместо боевого каталога: ровно одна stop-задача,
 *    чтобы flip-сценарий (реактивация посреди стопов) детерминированно
 *    доходил до move-транзакции;
 *  - planner обёрнут только ради метки 'begin-merge' в журнале порядка.
 *
 * Журнал calls фиксирует порядок из плана Task 19:
 *   ['credit-survivor','debit-loser','begin-merge','stop-loser','move-identities']
 *
 * Здесь же — PG-половина фиксов ревью Task 18 (T18-M1: runJob обязан
 * нормализовать running-строку через claimById; T18-M2: cancelled-строка —
 * DeletionCancelledError, а не retry) и m3: провал планировщика откатывает
 * поколение.
 */

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `identity_merge_del_spec_${process.pid}`;

const SURVIVOR = 'u-target';
const LOSER = 'u-conflict';
const PERSONAL_CANARY = 'ЛИЧНЫЙ-ТЕКСТ';
const STOP_TYPE: DeletionResourceType = 'integration.apple.stop';

const DELETION_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const NEW_DELETION_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const DELETED_AT = new Date('2026-11-01T00:00:00.000Z');

jest.setTimeout(60_000);

maybe('merge loser — поколение удаления и отложенный purge (Task 19, PG)', () => {
  let pool: Pool;
  let admin: Pool;

  async function rows(sql: string, params: any[] = []): Promise<any[]> {
    const r = await pool.query(sql, params);
    return r.rows;
  }

  interface SeedUserOptions {
    state?: string | null;
    deletionId?: string | null;
    deletedAt?: Date | null;
    createDate?: string;
    hash?: string | null;
    email?: string | null;
    welcomeAt?: Date | null;
    tokens?: number;
  }

  async function seedUser(userId: string, opts: SeedUserOptions = {}) {
    await pool.query(
      `INSERT INTO user_id
        (internal_id, state, deletion_id, deleted_at, create_date,
         password_hash, primary_email, welcome_bonus_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        userId,
        opts.state ?? 'active',
        opts.deletionId ?? null,
        opts.deletedAt ?? null,
        opts.createDate ?? '2026-01-01 00:00:00',
        opts.hash ?? null,
        opts.email ?? null,
        opts.welcomeAt ?? null,
      ],
    );
    await pool.query(
      `INSERT INTO ai_profiles_consolidated (user_id, tokens) VALUES ($1,$2)`,
      [userId, opts.tokens ?? 0],
    );
  }

  /** survivor старше — выживает targetUserId (правило mergeAccounts). */
  async function seedMergePair() {
    await seedUser(SURVIVOR, {
      createDate: '2026-01-01 00:00:00',
      tokens: 100,
      hash: 'SURVIVOR-HASH',
      email: 'survivor@example.test',
    });
    await seedUser(LOSER, {
      createDate: '2026-02-01 00:00:00',
      tokens: 8897,
      hash: 'LOSER-HASH',
      email: 'loser@example.test',
      welcomeAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    await seedIdentity(LOSER, 'email', 'loser-login@example.test');
    await seedIdentity(SURVIVOR, 'phone', '70000000001');
    await seedHistory(LOSER, PERSONAL_CANARY);
    await tgLink(LOSER, '111111111');
    await tgLink(SURVIVOR, '222222222');
  }

  async function seedIdentity(userId: string, provider: string, sub: string) {
    await pool.query(
      `INSERT INTO user_identities (user_id, provider, provider_sub)
       VALUES ($1,$2,$3)`,
      [userId, provider, sub],
    );
  }

  async function seedHistory(userId: string, content: string) {
    await pool.query(
      `INSERT INTO custom_chat_history (session_id, sender_type, content)
       VALUES ($1 || '_1', 'human', $2)`,
      [userId, content],
    );
  }

  async function tgLink(userId: string, tgUserId: string) {
    await pool.query(
      `INSERT INTO tg_user_identities (linkeon_user_id, tg_user_id)
       VALUES ($1,$2::bigint)`,
      [userId, tgUserId],
    );
  }

  async function seedJobRow(
    userId: string,
    deletionId: string,
    resourceType: string,
    resourceKey: string,
  ) {
    await pool.query(
      `INSERT INTO account_deletion_jobs
        (deletion_id,user_id,resource_type,resource_key,phase,payload_jsonb,
         status,next_attempt_at)
       VALUES ($1,$2,$3,$4,'immediate','{}'::jsonb,'pending', now())`,
      [deletionId, userId, resourceType, resourceKey],
    );
  }

  async function userRow(userId: string) {
    const r = await rows(
      `SELECT state, deletion_id, deleted_at, password_hash, primary_email,
              welcome_bonus_at, create_date
       FROM user_id WHERE internal_id=$1`,
      [userId],
    );
    return r[0];
  }

  async function balance(userId: string): Promise<number> {
    const r = await rows(
      `SELECT tokens FROM ai_profiles_consolidated WHERE user_id=$1`,
      [userId],
    );
    return Number(r[0].tokens);
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

  async function tgRows(): Promise<Array<{ linkeon_user_id: string; tg: string }>> {
    return rows(
      `SELECT linkeon_user_id, tg_user_id::text AS tg
       FROM tg_user_identities ORDER BY linkeon_user_id`,
    );
  }

  async function jobCount(deletionId?: string): Promise<number> {
    const r = await rows(
      `SELECT count(*)::int AS n FROM account_deletion_jobs
        WHERE ($1::uuid IS NULL OR deletion_id=$1)`,
      [deletionId ?? null],
    );
    return r[0].n;
  }

  /** Прецедент Task 17: новое поколение без очистки — как реактивация. */
  async function reactivate(userId: string, deletionId: string) {
    await pool.query(
      `UPDATE user_id SET state='active', deletion_id=$2, deleted_at=NULL
        WHERE internal_id=$1`,
      [userId, deletionId],
    );
  }

  /**
   * Реестр-фейк: один внешний стоп (integration.apple.stop) вместо боевого
   * каталога адаптеров. Наблюдения фиксируют состояние таблиц В МОМЕНТ стопа;
   * hooks исполняются внутри execute (для flip-сценария); failures роняют
   * адаптер нужной ошибкой.
   */
  class FakeRegistry {
    readonly failures = new Map<string, unknown>();
    readonly observations: { identitiesAtStop: number | null; tgAtStop: number | null } = {
      identitiesAtStop: null,
      tgAtStop: null,
    };
    hooks: Array<(job: DeletionJobRow, ctx: DeletionExecution) => Promise<void>> = [];

    constructor(readonly calls: string[]) {}

    assertReady(): void {}

    fail(resourceType: DeletionResourceType, error: unknown): void {
      this.failures.set(resourceType, error);
    }

    getExecutor(resourceType: DeletionResourceType) {
      return {
        resourceTypes: [resourceType],
        execute: async (job: DeletionJobRow, ctx: DeletionExecution) => {
          this.calls.push(resourceType === STOP_TYPE ? 'stop-loser' : resourceType);
          if (resourceType === STOP_TYPE) {
            const ids = await ctx.db.query(
              `SELECT count(*)::int AS n FROM user_identities WHERE user_id=$1`,
              [LOSER],
            );
            this.observations.identitiesAtStop = ids.rows[0].n;
            const tg = await ctx.db.query(
              `SELECT count(*)::int AS n FROM tg_user_identities WHERE linkeon_user_id=$1`,
              [LOSER],
            );
            this.observations.tgAtStop = tg.rows[0].n;
          }
          for (const hook of this.hooks) await hook(job, ctx);
          const failure = this.failures.get(resourceType);
          if (failure) throw failure;
        },
      };
    }
  }

  const stopDiscoverer: DeletionDiscoverer = async () => ({
    jobs: [{
      resourceType: STOP_TYPE,
      resourceKey: 'apple',
      phase: 'immediate',
      payload: {},
    }],
    skips: [],
  });

  /**
   * db-обёртка поверх пула: journal отмечает точки, по которым план проверяет
   * порядок (credit-first, перенос идентичностей). Остальной SQL не помечается.
   */
  function makeDb(calls: string[]) {
    const journal = (sql: string, params: any[] = []) => {
      if (/add_user_tokens/i.test(sql)) {
        calls.push(Number(params[1]) >= 0 ? 'credit-survivor' : 'debit-loser');
      } else if (/UPDATE\s+user_identities\s+SET\s+user_id/i.test(sql)) {
        calls.push('move-identities');
      }
    };
    return {
      query: (sql: string, params?: any[]) => {
        journal(sql, params ?? []);
        return pool.query(sql, params as any[]);
      },
      getClient: async () => {
        const client = await pool.connect();
        return {
          query: (sql: string, params?: any[]) => {
            journal(sql, params ?? []);
            return client.query(sql, params as any[]);
          },
          release: (err?: any) => client.release(err),
        };
      },
    };
  }

  /**
   * Стек: настоящие jobs/runner/planner/lifecycle + IdentityService. Lifecycle
   * отдаётся сервису через фейковый ModuleRef ({ get }) — так unit-контур
   * воспроизводит DI без Nest-контейнера.
   */
  function makeStack(discoverers: DeletionDiscoverer[] = [stopDiscoverer]) {
    const calls: string[] = [];
    const db = makeDb(calls);
    const jobs = new AccountDeletionJobs(db as any);
    const registry = new FakeRegistry(calls);
    const runner = new AccountDeletionRunner(db as any, jobs as any, registry as any);
    const inner = new AccountDeletionPlanner(discoverers);
    const planner = {
      collect: async (dbArg: any, account: any, origin: any) => {
        calls.push('begin-merge');
        return inner.collect(dbArg, account, origin);
      },
      persist: (dbArg: any, account: any, plan: any) => inner.persist(dbArg, account, plan),
    };
    const lifecycle = new AccountDeletionLifecycle(
      db as any,
      planner as any,
      jobs,
      registry as any,
      runner,
    );
    const moduleRef = { get: () => lifecycle };
    const svc = new IdentityService(db as any, undefined, undefined, moduleRef as any);
    return { calls, db, jobs, registry, runner, lifecycle, svc };
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 2, options: `-c search_path=${SCHEMA}` });

    // transaction_type_enum — дословно 001_core_schema.sql: нужен
    // token_transactions и add_user_tokens (merge пишет 'adjustment').
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
    // + default (:10489): история loser ЖДЁТ purge (30 дней), не удаляется в merge.
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

    // ai_profiles_consolidated — дословно (:841) + seq + UNIQUE(user_id): баланс.
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

    // token_transactions — дословно (:8885): сюда пишет add_user_tokens.
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
    // без схемы-квалификации: credit-first перенос баланса идёт через неё,
    // включая FOR UPDATE и запись транзакции.
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
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE account_deletion_jobs, custom_chat_history, ai_profiles_consolidated,
                token_transactions, user_identities, tg_user_identities, user_id`,
    );
  });

  it('merge: credit-first, стоп до переноса, поколение и отложенный core purge', async () => {
    await seedMergePair();
    const { svc, calls, registry } = makeStack();

    const r = await svc.mergeAccounts(LOSER, SURVIVOR);

    expect(r).toEqual({ survivorUserId: SURVIVOR, loserUserId: LOSER });
    // Порядок из плана: баланс первым (credit-first), затем поколение, затем
    // внешние стопы, и только потом перенос идентичностей.
    expect(calls).toEqual([
      'credit-survivor',
      'debit-loser',
      'begin-merge',
      'stop-loser',
      'move-identities',
    ]);
    // В момент стопа идентичности и tg ещё НА loser: apple.revokeToken читает
    // provider_refresh_token из user_identities — отсюда «revoke ДО переноса».
    expect(registry.observations.identitiesAtStop).toBe(1);
    expect(registry.observations.tgAtStop).toBe(1);

    // Loser: поколение удаления создано.
    const loser = await userRow(LOSER);
    expect(loser.state).toBe('deleted');
    expect(loser.deletion_id).toBeTruthy();
    expect(loser.deleted_at).not.toBeNull();

    // Core merge-происхождения — purge, отложенный на 30 дней от deleted_at:
    // данные ждут срок, а не стираются синхронно с merge.
    const core = await rows(
      `SELECT resource_type, phase, status, next_attempt_at
       FROM account_deletion_jobs
       WHERE deletion_id=$1 AND resource_key='account'`,
      [loser.deletion_id],
    );
    expect(core).toHaveLength(1);
    expect(core[0]).toMatchObject({
      resource_type: 'account.core.purge',
      phase: 'purge',
      status: 'pending',
    });
    expect(new Date(core[0].next_attempt_at).getTime()).toBe(
      new Date(loser.deleted_at).getTime() + ACCOUNT_DELETION_RETENTION_MS,
    );

    // Стоп завершён.
    const stop = await rows(
      `SELECT status FROM account_deletion_jobs
       WHERE deletion_id=$1 AND resource_type=$2`,
      [loser.deletion_id, STOP_TYPE],
    );
    expect(stop[0].status).toBe('done');

    // История чатов НЕ переносится и НЕ удаляется: она ждёт purge (30 дней).
    expect(await historyCount(LOSER)).toBe(1);

    // Идентичности перенесены: у survivor обе, у loser ноль.
    expect(await identityCount(SURVIVOR)).toBe(2);
    expect(await identityCount(LOSER)).toBe(0);

    // Баланс: credit-first довёл перенос до конца.
    expect(await balance(SURVIVOR)).toBe(100 + 8897);
    expect(await balance(LOSER)).toBe(0);

    // tg loser отвязан ПОСЛЕ стопа; survivor TG не затронут.
    expect(await tgRows()).toEqual([
      { linkeon_user_id: SURVIVOR, tg: '222222222' },
    ]);

    // Tombstone loser зачищен gen-gated; survivor не тронут pipeline.
    // welcome_bonus_at loser сохранён (T20-M1): бонус один раз на аккаунт.
    expect(loser.password_hash).toBeNull();
    expect(loser.primary_email).toBeNull();
    expect(loser.welcome_bonus_at).not.toBeNull();
    expect(new Date(loser.welcome_bonus_at).toISOString()).toBe('2026-02-01T00:00:00.000Z');
    const survivor = await userRow(SURVIVOR);
    expect(survivor.state).toBe('active');
    expect(survivor.deletion_id).toBeNull();
    expect(survivor.deleted_at).toBeNull();
    expect(survivor.password_hash).toBe('SURVIVOR-HASH');
    expect(survivor.primary_email).toBe('survivor@example.test');
  });

  it('лог переноса баланса — uuid строк user_id, без internal_id (номера) обеих сторон', async () => {
    // У телефонного входа internal_id — это сам номер, ему в логе не место
    // (T20-M1). В лог — user_id.id обеих сторон, как в логах бонуса.
    const SURVIVOR_PHONE = '79990000201';
    const LOSER_PHONE = '79990000202';
    await seedUser(SURVIVOR_PHONE, { createDate: '2026-01-01 00:00:00', tokens: 100 });
    await seedUser(LOSER_PHONE, { createDate: '2026-02-01 00:00:00', tokens: 500 });
    const [survivorRow] = await rows(`SELECT id FROM user_id WHERE internal_id=$1`, [SURVIVOR_PHONE]);
    const [loserRow] = await rows(`SELECT id FROM user_id WHERE internal_id=$1`, [LOSER_PHONE]);
    const { svc } = makeStack();
    const log = jest.spyOn((svc as any).logger, 'log').mockImplementation(() => undefined);

    let messages: string[];
    try {
      expect(await svc.mergeAccounts(LOSER_PHONE, SURVIVOR_PHONE))
        .toEqual({ survivorUserId: SURVIVOR_PHONE, loserUserId: LOSER_PHONE });
      messages = log.mock.calls.map(([m]) => String(m));
    } finally {
      log.mockRestore();
    }

    const merge = messages.filter((m) => m.startsWith('merge:'));
    expect(merge).toEqual([
      `merge: 500 токенов user_id.id=${loserRow.id} → user_id.id=${survivorRow.id}`,
    ]);
    expect(merge[0]).not.toContain(SURVIVOR_PHONE);
    expect(merge[0]).not.toContain(LOSER_PHONE);
    // Перенос состоялся — лог описывает реальное движение баланса.
    expect(await balance(SURVIVOR_PHONE)).toBe(600);
    expect(await balance(LOSER_PHONE)).toBe(0);
  });

  it('провал стопа — идентичности не перенесены, история цела, ошибка всплывает как есть', async () => {
    await seedMergePair();
    const { svc, calls, registry } = makeStack();
    registry.fail(STOP_TYPE, new DeletionRetryError('timeout'));

    // Проброс как есть, без HTTP-маппинга: контроллер merge не оборачивает.
    const error = await svc.mergeAccounts(LOSER, SURVIVOR).catch((e) => e);
    expect(error).toBeInstanceOf(DeletionRetryError);
    expect((error as DeletionRetryError).kind).toBe('db');

    // Переноса не было.
    expect(calls).toEqual(['credit-survivor', 'debit-loser', 'begin-merge', 'stop-loser']);
    expect(await identityCount(LOSER)).toBe(1);
    expect(await identityCount(SURVIVOR)).toBe(1);
    expect(await historyCount(LOSER)).toBe(1);
    expect((await tgRows()).length).toBe(2);

    // Поколение создано (begin до стопов), стоп failed — повторный merge
    // продолжит с того же места, воркер тоже подберёт.
    const loser = await userRow(LOSER);
    expect(loser.state).toBe('deleted');
    expect(loser.deletion_id).toBeTruthy();
    const stop = await rows(
      `SELECT status, last_error_kind FROM account_deletion_jobs
       WHERE deletion_id=$1 AND resource_type=$2`,
      [loser.deletion_id, STOP_TYPE],
    );
    expect(stop[0]).toMatchObject({ status: 'failed', last_error_kind: 'timeout' });

    // Credit-first уже состоялся: баланс на survivor (падаем в пользу человека).
    expect(await balance(SURVIVOR)).toBe(100 + 8897);
    expect(await balance(LOSER)).toBe(0);
    // Tombstone не зачищен — move-транзакция не начиналась.
    expect(loser.password_hash).toBe('LOSER-HASH');
  });

  it('повторный merge — без задвоения баланса, то же поколение, без дублей задач', async () => {
    await seedMergePair();
    const first = makeStack();
    await first.svc.mergeAccounts(LOSER, SURVIVOR);
    const loser1 = await userRow(LOSER);
    const jobsAfterFirst = await jobCount();
    expect(jobsAfterFirst).toBe(2); // stop done + core purge pending

    const second = makeStack();
    await second.svc.mergeAccounts(LOSER, SURVIVOR);

    // Баланс loser уже ноль — add_user_tokens не вызывается вовсе.
    expect(second.calls).toEqual(['begin-merge', 'move-identities']);
    expect(await balance(SURVIVOR)).toBe(100 + 8897);
    expect(await balance(LOSER)).toBe(0);
    // Поколение переиспользовано, задачи не задвоены (ON CONFLICT DO NOTHING).
    const loser2 = await userRow(LOSER);
    expect(loser2.deletion_id).toBe(loser1.deletion_id);
    expect(await jobCount()).toBe(jobsAfterFirst);
    // UPDATE user_identities на 0 строк — не ошибка.
    expect(await identityCount(SURVIVOR)).toBe(2);
    expect(await identityCount(LOSER)).toBe(0);
  });

  it('реактивация во время стопа — assertCurrent откатывает перенос (cancelled)', async () => {
    await seedMergePair();
    const { svc, registry } = makeStack();
    registry.hooks.push(async () => {
      await reactivate(LOSER, NEW_DELETION_ID);
    });

    const error = await svc.mergeAccounts(LOSER, SURVIVOR).catch((e) => e);
    expect(error).toBeInstanceOf(DeletionCancelledError);

    // Move-транзакция откатилась целиком: идентичности, tombstone, tg — целы.
    expect(await identityCount(LOSER)).toBe(1);
    expect(await identityCount(SURVIVOR)).toBe(1);
    expect(await historyCount(LOSER)).toBe(1);
    expect((await tgRows()).length).toBe(2);
    const loser = await userRow(LOSER);
    expect(loser.state).toBe('active');
    expect(loser.deletion_id).toBe(NEW_DELETION_ID);
    expect(loser.password_hash).toBe('LOSER-HASH');
    expect(loser.primary_email).toBe('loser@example.test');
    // Credit-first не атомарен с переносом (осознанно): баланс уже на survivor.
    expect(await balance(SURVIVOR)).toBe(100 + 8897);
    expect(await balance(LOSER)).toBe(0);
  });

  it('historical loser без поколения — legacy-путь: перенос и deleted без pipeline', async () => {
    // Отклонение #1 плана: begin→null для historical-удаления (deleted без
    // deletion_id). Сохраняем прежний UX merge — перенос идентичностей и
    // пометка deleted, но без поколения и задач: стирать уже нечего.
    await seedUser(SURVIVOR, { createDate: '2026-01-01 00:00:00', tokens: 100 });
    await seedUser(LOSER, {
      state: 'deleted',
      deletionId: null,
      deletedAt: null,
      createDate: '2026-02-01 00:00:00',
      tokens: 500,
    });
    await seedIdentity(LOSER, 'email', 'loser-login@example.test');
    await seedIdentity(SURVIVOR, 'phone', '70000000001');
    const { svc, calls } = makeStack();

    const r = await svc.mergeAccounts(LOSER, SURVIVOR);

    expect(r).toEqual({ survivorUserId: SURVIVOR, loserUserId: LOSER });
    expect(await balance(SURVIVOR)).toBe(600);
    expect(await balance(LOSER)).toBe(0);
    // begin вернул null — планировщик не вызывался, стопов нет.
    expect(calls).toEqual(['credit-survivor', 'debit-loser', 'move-identities']);
    expect(await identityCount(SURVIVOR)).toBe(2);
    expect(await identityCount(LOSER)).toBe(0);
    const loser = await userRow(LOSER);
    expect(loser.state).toBe('deleted');
    expect(loser.deletion_id).toBeNull();
    expect(await jobCount()).toBe(0);
  });

  it('blocked loser — legacy-путь (прежнее поведение merge сохранено)', async () => {
    // Та же ветка begin→null: state='blocked' — не active, pipeline не
    // включается (FU-T11-2), но ожидание человека от merge прежнее —
    // способы входа переносятся на survivor.
    await seedUser(SURVIVOR, { createDate: '2026-01-01 00:00:00', tokens: 0 });
    await seedUser(LOSER, { state: 'blocked', createDate: '2026-02-01 00:00:00', tokens: 0 });
    await seedIdentity(LOSER, 'email', 'loser-login@example.test');
    const { svc, calls } = makeStack();

    await svc.mergeAccounts(LOSER, SURVIVOR);

    expect(calls).toEqual(['move-identities']);
    expect(await identityCount(SURVIVOR)).toBe(1);
    expect(await identityCount(LOSER)).toBe(0);
    const loser = await userRow(LOSER);
    expect(loser.state).toBe('deleted');
    expect(loser.deletion_id).toBeNull();
    expect(await jobCount()).toBe(0);
  });

  it('m3: провал планировщика внутри begin — поколение откатывается', async () => {
    await seedMergePair();
    const stack = makeStack([
      async () => {
        throw new Error('planner-boom');
      },
    ]);

    await expect(stack.svc.mergeAccounts(LOSER, SURVIVOR)).rejects.toThrow('planner-boom');

    // Begin-транзакция откатилась вместе с UPDATE state='deleted':
    // «удалён наполовину» не возникает.
    const loser = await userRow(LOSER);
    expect(loser.state).toBe('active');
    expect(loser.deletion_id).toBeNull();
    expect(loser.deleted_at).toBeNull();
    expect(await jobCount()).toBe(0);
    expect(await identityCount(LOSER)).toBe(1);
    // Credit-first уже произошёл (баланс до begin) — фиксируем семантику.
    expect(await balance(SURVIVOR)).toBe(100 + 8897);
    expect(await balance(LOSER)).toBe(0);
  });

  describe('нормализация runJob (T18-M1/M2, PG)', () => {
    it('running с живым lease — адаптер не исполняется, retry(db)', async () => {
      await seedUser(LOSER, {
        state: 'deleted',
        deletionId: DELETION_ID,
        deletedAt: DELETED_AT,
      });
      await seedJobRow(LOSER, DELETION_ID, 'routine.stop', 'routine');
      const { jobs, runner, registry } = makeStack();

      // Чужой исполнитель заклеймил задачу: lease живой.
      const claimed = await jobs.claimNextStop(DELETION_ID);
      expect(claimed).not.toBeNull();
      expect(claimed!.status).toBe('running');
      const fresh = await jobs.find(DELETION_ID, 'routine.stop', 'routine');
      expect(fresh.status).toBe('running');

      const error = await runner.runJob(fresh).catch((e) => e);

      expect(error).toBeInstanceOf(DeletionRetryError);
      expect((error as DeletionRetryError).kind).toBe('db');
      expect(registry.calls).toEqual([]);
      const after = await rows(
        `SELECT status, attempts FROM account_deletion_jobs WHERE deletion_id=$1`,
        [DELETION_ID],
      );
      // Наш вход строку не трогал: attempts чужого claim, статус running.
      expect(after[0]).toMatchObject({ status: 'running', attempts: 1 });
    });

    it('running с истёкшим lease — реклейм (attempts+1) и исполнение', async () => {
      await seedUser(LOSER, {
        state: 'deleted',
        deletionId: DELETION_ID,
        deletedAt: DELETED_AT,
      });
      await seedJobRow(LOSER, DELETION_ID, 'routine.stop', 'routine');
      const { jobs, runner, registry } = makeStack();
      await jobs.claimNextStop(DELETION_ID);
      await pool.query(
        `UPDATE account_deletion_jobs
            SET lease_until = now() - interval '1 minute'
          WHERE deletion_id=$1`,
        [DELETION_ID],
      );
      const fresh = await jobs.find(DELETION_ID, 'routine.stop', 'routine');

      await runner.runJob(fresh);

      expect(registry.calls).toEqual(['routine.stop']);
      const after = await rows(
        `SELECT status, attempts FROM account_deletion_jobs WHERE deletion_id=$1`,
        [DELETION_ID],
      );
      // Исполнение ПОСЛЕ реклейма: attempts incremented, lease свежий.
      expect(after[0]).toMatchObject({ status: 'done', attempts: 2 });
    });

    it('cancelled-строка — DeletionCancelledError(kind=cancelled), не retry(db)', async () => {
      await seedUser(LOSER, {
        state: 'deleted',
        deletionId: DELETION_ID,
        deletedAt: DELETED_AT,
      });
      await seedJobRow(LOSER, DELETION_ID, 'routine.stop', 'routine');
      await pool.query(
        `UPDATE account_deletion_jobs SET status='cancelled' WHERE deletion_id=$1`,
        [DELETION_ID],
      );
      const { jobs, runner, registry } = makeStack();
      const cancelled = await jobs.find(DELETION_ID, 'routine.stop', 'routine');

      const error = await runner.runJob(cancelled).catch((e) => e);

      expect(error).toBeInstanceOf(DeletionCancelledError);
      expect((error as any).kind).toBe('cancelled');
      expect(registry.calls).toEqual([]);
      const after = await rows(
        `SELECT status, attempts FROM account_deletion_jobs WHERE deletion_id=$1`,
        [DELETION_ID],
      );
      expect(after[0]).toMatchObject({ status: 'cancelled', attempts: 0 });
    });
  });
});
