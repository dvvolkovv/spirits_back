import { readFileSync } from 'fs';
import { Pool } from 'pg';
import { IdentityService, WELCOME_BONUS } from './identity.service';
import type { ResolveResult } from './identity.types';

/**
 * Task 22.5 — state-guard в resolveOrCreate против настоящей Postgres.
 *
 * Шаги 1 (найденная связка provider/provider_sub) и 2 (merge по verified
 * email) возвращали ok БЕЗ чтения user_id.state, и checkCode подписывал
 * свежие access+refresh JWT на мёртвую запись: зависшее поколение удаления,
 * in-flight удаление или historical-строка state='deleted' пускали человека
 * в кабинет, где data-сервисы гейтят state='active' (чат-история молча не
 * сохраняется), а refresh-guard отсекал только на следующем refresh (~2ч).
 * Те же входы наследуют дыру: OAuth-контроллеры, tma, talerid.
 *
 * Фикс: при state='deleted' — IN-PLACE реактивация НАЙДЕННОГО userId
 * (reactivateIfNeeded: отмена незавершённых задач поколения + снятие
 * deletion_id/deleted_at + state='active'), ensureProfile и issueWelcomeBonus
 * — одной транзакцией; fall-through в шаг 3 запрещён (create для не-телефона
 * вставил бы ВТОРОЙ user_id). Гейт-форма: только 'deleted'; 'blocked' не
 * флипаем (самоликвидация модерации, FU-T11-2), NULL не лечим.
 *
 * Контур — прецедент identity.reactivation.pg.spec.ts (Task 20): настоящая
 * БД, per-pid схема, DDL дословно из реальных миграций; НАСТОЯЩИЙ
 * IdentityService.resolveOrCreate без deletion-стека (состояние удаления
 * сеется напрямую — сценарий «поколение зависло/in-flight, core не исполнен»).
 * Отличия харнеса:
 *  - FakeEvents-журнал: track() синхронно пишет снимок счётчиков транзакций
 *    — пин «auth_succeeded ПОСЛЕ commit» (ловушка: inTransaction → getClient,
 *    обёртка считает BEGIN/COMMIT/ROLLBACK);
 *  - getClient инструментирован теми же счётчиками.
 *
 * Сценарии:
 *  1. зависшее удаление (state='deleted', deletion_id, живая phone-связка,
 *     незавершённые задачи поколения, canary в custom_chat_history) → вход
 *     тем же номером: ok/isNew:false, in-place реактивация, задачи поколения
 *     cancelled (done не тронут — пин фактической семантики
 *     reactivateIfNeeded), canary жив, второй строки user_id нет, связка не
 *     задвоена (UNIQUE(provider, provider_sub) — ловушка 1), бонус не задвоен;
 *  1b. historical deleted (deletion_id NULL) с живой связкой — реактивация,
 *     отмена задач no-op (ловушка 5);
 *  2. зеркало для шага 2 (verified email, вход через google): реактивация
 *     найденного userId, count(user_id)=1 (пин запрета fall-through в шаг 3),
 *     новая ссылка провайдера вставлена РОВНО ОДИН раз;
 *  3. characterization: 'blocked' → ok, state остался 'blocked'; NULL → ok,
 *     остался NULL; реактивационная транзакция не начиналась;
 *  4. auth_succeeded записан ПОСЛЕ commit реактивации (счётчики в журнале),
 *     signup_completed на входе не пишется.
 */

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `identity_state_guard_spec_${process.pid}`;

const PERSONAL_CANARY = 'ЛИЧНЫЙ-ТЕКСТ';

jest.setTimeout(60_000);

interface TrackEntry {
  name: string;
  userId: string | null;
  props: Record<string, unknown>;
  /** Открытые транзакции на момент track(). */
  openTx: number;
  /** Накопленное число COMMIT на момент track(). */
  commits: number;
}


maybe('state-guard resolveOrCreate: deleted при входе реактивируется in-place (T22.5, PG)', () => {
  let pool: Pool;
  let admin: Pool;

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
      `SELECT state, deletion_id, deleted_at, welcome_bonus_at
       FROM user_id WHERE internal_id=$1`,
      [userId],
    );
    return r[0];
  }

  async function userCount(): Promise<number> {
    const r = await rows(`SELECT count(*)::int AS n FROM user_id`);
    return r[0].n;
  }

  async function identityRows(userId: string) {
    return rows(
      `SELECT provider, provider_sub FROM user_identities WHERE user_id=$1 ORDER BY provider`,
      [userId],
    );
  }

  async function identityCount(userId: string): Promise<number> {
    const r = await rows(
      `SELECT count(*)::int AS n FROM user_identities WHERE user_id=$1`,
      [userId],
    );
    return r[0].n;
  }

  async function jobRows(deletionId: string) {
    return rows(
      `SELECT resource_type, status, lease_until, completed_at
       FROM account_deletion_jobs WHERE deletion_id=$1
       ORDER BY resource_type`,
      [deletionId],
    );
  }

  async function jobCount(): Promise<number> {
    const r = await rows(`SELECT count(*)::int AS n FROM account_deletion_jobs`);
    return r[0].n;
  }

  async function balance(userId: string): Promise<number> {
    const r = await rows(
      `SELECT tokens FROM ai_profiles_consolidated WHERE user_id=$1`,
      [userId],
    );
    return Number(r[0]?.tokens ?? 0);
  }

  async function profileRowCount(userId: string): Promise<number> {
    const r = await rows(
      `SELECT count(*)::int AS n FROM ai_profiles_consolidated WHERE user_id=$1`,
      [userId],
    );
    return r[0].n;
  }

  async function historyRows(userId: string) {
    return rows(
      `SELECT content FROM custom_chat_history
        WHERE session_id LIKE $1 || '\\_%' ESCAPE '\\'`,
      [userId],
    );
  }

  async function seedHistory(userId: string, content: string): Promise<void> {
    await pool.query(
      `INSERT INTO custom_chat_history (session_id, sender_type, content)
       VALUES ($1 || '_1', 'human', $2)`,
      [userId, content],
    );
  }

  // --------------------------------------------------------------- seeding

  /**
   * Удалённый аккаунт, у которого связка входа ЖИВА: core.immediate до неё
   * не дошёл (зависшее/in-flight удаление) или это historical-строка.
   * welcome_bonus_at сохранён (tombstone его и не сбрасывает — T20-M1),
   * баланс — как после регистрации.
   */
  async function seedDeletedPhone(phone: string, deletionId: string | null): Promise<void> {
    // Номер передаётся ДВУМЯ параметрами: $1, использованный и в varchar
    // (internal_id), и в text (primary_phone), PG не может вывести тип —
    // «inconsistent types deduced for parameter $1».
    await pool.query(
      `INSERT INTO user_id (internal_id, primary_phone, state, deletion_id, deleted_at, welcome_bonus_at)
       VALUES ($1, $2, 'deleted', $3::uuid, now() - interval '2 hours', now() - interval '30 days')`,
      [phone, phone, deletionId],
    );
    await pool.query(
      `INSERT INTO user_identities (user_id, provider, provider_sub, email_verified, last_used_at)
       VALUES ($1, 'phone', $2, false, now() - interval '2 hours')`,
      [phone, phone],
    );
    await pool.query(
      `INSERT INTO ai_profiles_consolidated (user_id, tokens) VALUES ($1, $2)`,
      [phone, WELCOME_BONUS],
    );
  }

  /**
   * Поколение удаления с незавершёнными задачами: pending core, running stop
   * с живым lease и ОДНА done-задача — пин фактической семантики
   * reactivateIfNeeded (WHERE status IN ('pending','running','failed')):
   * done реактивация не трогает.
   */
  async function seedGenerationJobs(userId: string, deletionId: string): Promise<void> {
    await pool.query(
      `INSERT INTO account_deletion_jobs
         (deletion_id, user_id, resource_type, resource_key, phase, payload_jsonb, status)
       VALUES ($1, $2, 'account.core.immediate', 'account', 'immediate', '{}'::jsonb, 'pending')`,
      [deletionId, userId],
    );
    await pool.query(
      `INSERT INTO account_deletion_jobs
         (deletion_id, user_id, resource_type, resource_key, phase, payload_jsonb,
          status, attempts, lease_until)
       VALUES ($1, $2, 'routine.stop', 'routine', 'immediate', '{}'::jsonb,
               'running', 1, now() + interval '5 minutes')`,
      [deletionId, userId],
    );
    await pool.query(
      `INSERT INTO account_deletion_jobs
         (deletion_id, user_id, resource_type, resource_key, phase, payload_jsonb,
          status, attempts, completed_at)
       VALUES ($1, $2, 'support.stop', 'support', 'immediate', '{}'::jsonb,
               'done', 1, now() - interval '1 hour')`,
      [deletionId, userId],
    );
  }

  /** Аккаунт модерации: state='blocked', живая связка, бонус уже получен. */
  async function seedBlockedPhone(phone: string): Promise<void> {
    await pool.query(
      `INSERT INTO user_id (internal_id, primary_phone, state, welcome_bonus_at)
       VALUES ($1, $2, 'blocked', now() - interval '10 days')`,
      [phone, phone],
    );
    await pool.query(
      `INSERT INTO user_identities (user_id, provider, provider_sub, email_verified)
       VALUES ($1, 'phone', $2, false)`,
      [phone, phone],
    );
    await pool.query(
      `INSERT INTO ai_profiles_consolidated (user_id, tokens) VALUES ($1, 0)`,
      [phone],
    );
  }

  // ----------------------------------------------------------------- stack

  /**
   * Счётчики транзакций + журнал track(). track() в проде fire-and-forget и
   * синхронный — снимок счётчиков в момент вызова доказывает порядок
   * «COMMIT реактивации → track».
   */
  function makeStack() {
    const counters = { openTx: 0, commits: 0, rollbacks: 0 };
    const events = {
      journal: [] as TrackEntry[],
      track(
        name: string,
        opts: { userId?: string | null; props?: Record<string, unknown> } = {},
      ): void {
        this.journal.push({
          name,
          userId: opts.userId ?? null,
          props: opts.props ?? {},
          openTx: counters.openTx,
          commits: counters.commits,
        });
      },
    };
    const db = {
      query: (sql: string, params?: any[]) => pool.query(sql, params as any[]),
      // inTransaction (blog-slot-claim) берёт выделенное соединение: считаем
      // BEGIN/COMMIT/ROLLBACK, чтобы журнал track() знал состояние транзакций.
      getClient: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, params?: any[]) => {
            const marker = String(sql).trim().toUpperCase();
            if (marker === 'BEGIN') counters.openTx += 1;
            const res = await client.query(sql, params as any[]);
            if (marker === 'COMMIT') {
              counters.openTx -= 1;
              counters.commits += 1;
            } else if (marker === 'ROLLBACK') {
              counters.openTx -= 1;
              counters.rollbacks += 1;
            }
            return res;
          },
          release: (err?: any) => client.release(err),
        };
      },
    };
    const identity = new IdentityService(db as any, events as any);
    return { identity, events, counters };
  }

  // ------------------------------------------------------------------- DDL

  beforeAll(async () => {
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
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE account_deletion_jobs, custom_chat_history,
                ai_profiles_consolidated, token_transactions,
                user_identities, user_id`,
    );
  });

  // ----------------------------------------------------------------- tests

  it('шаг 1: зависшее удаление с живой связкой — вход тем же номером реактивирует in-place, поколение снято, canary жив', async () => {
    const PHONE = '79990000201';
    const GEN1 = 'd0000000-0000-4000-8000-000000000001';
    await seedDeletedPhone(PHONE, GEN1);
    await seedGenerationJobs(PHONE, GEN1);
    await seedHistory(PHONE, PERSONAL_CANARY);

    const stack = makeStack();
    const r = ok(await stack.identity.resolveOrCreate('phone', { phone: PHONE }));
    expect(r.userId).toBe(PHONE);
    expect(r.isNew).toBe(false);
    expect(r.mergedExisting).toBe(false);

    // Строка аккаунта: та же, активная, без следов поколения.
    const u = await userRow(PHONE);
    expect(u.state).toBe('active');
    expect(u.deletion_id).toBeNull();
    expect(u.deleted_at).toBeNull();

    // Поколение: незавершённые задачи cancelled и без lease (фактическая
    // семантика reactivateIfNeeded), выполненная done-задача не тронута.
    const jobs = await jobRows(GEN1);
    expect(jobs).toHaveLength(3);
    const core = jobs.find((j) => j.resource_type === 'account.core.immediate');
    expect(core.status).toBe('cancelled');
    expect(core.lease_until).toBeNull();
    expect(core.completed_at).not.toBeNull();
    const routine = jobs.find((j) => j.resource_type === 'routine.stop');
    expect(routine.status).toBe('cancelled');
    expect(routine.lease_until).toBeNull();
    expect(routine.completed_at).not.toBeNull();
    const support = jobs.find((j) => j.resource_type === 'support.stop');
    expect(support.status).toBe('done');

    // Canary жив: зависшее удаление его не стёрло, реактивация — тем более.
    const h = await historyRows(PHONE);
    expect(h).toHaveLength(1);
    expect(h[0].content).toBe(PERSONAL_CANARY);

    // In-place: второй строки аккаунта нет, связка входа не задвоена
    // (UNIQUE(provider, provider_sub) — ловушка 1), профиль один.
    expect(await userCount()).toBe(1);
    expect(await identityCount(PHONE)).toBe(1);
    expect(await profileRowCount(PHONE)).toBe(1);

    // Бонус не задвоен: welcome_bonus_at пережил зависшее удаление (tombstone
    // его не сбрасывает — T20-M1) — claim вернул 0 строк, add_user_tokens не
    // вызывался.
    expect(u.welcome_bonus_at).not.toBeNull();
    expect(await balance(PHONE)).toBe(WELCOME_BONUS);
  });

  it('шаг 1, ловушка 5: historical deleted без поколения — реактивация, отмена задач no-op', async () => {
    const PHONE = '79990000203';
    await seedDeletedPhone(PHONE, null);

    const stack = makeStack();
    const r = ok(await stack.identity.resolveOrCreate('phone', { phone: PHONE }));
    expect(r.userId).toBe(PHONE);
    expect(r.isNew).toBe(false);

    const u = await userRow(PHONE);
    expect(u.state).toBe('active');
    expect(u.deletion_id).toBeNull();
    expect(u.deleted_at).toBeNull();
    // Задач не было и не появилось.
    expect(await jobCount()).toBe(0);
    expect(await userCount()).toBe(1);
    expect(await identityCount(PHONE)).toBe(1);
    expect(await balance(PHONE)).toBe(WELCOME_BONUS);
  });

  it('шаг 2: verified email удалённого аккаунта — реактивация найденного userId, вторая строка user_id НЕ появляется, новая ссылка ровно одна', async () => {
    const UID = 'a1000000-0000-4000-8000-000000000002';
    const MAIL = 'state-guard-2@example.org';
    const GEN2 = 'd0000000-0000-4000-8000-000000000002';
    await pool.query(
      `INSERT INTO user_id (internal_id, primary_email, state, deletion_id, deleted_at, welcome_bonus_at)
       VALUES ($1, $2, 'deleted', $3::uuid, now() - interval '2 hours', now() - interval '30 days')`,
      [UID, MAIL, GEN2],
    );
    await pool.query(
      `INSERT INTO user_identities (user_id, provider, provider_sub, email, email_verified)
       VALUES ($1, 'email', $2, $3, true)`,
      [UID, MAIL, MAIL],
    );
    await pool.query(
      `INSERT INTO ai_profiles_consolidated (user_id, tokens) VALUES ($1, $2)`,
      [UID, WELCOME_BONUS],
    );
    await seedGenerationJobs(UID, GEN2);

    const stack = makeStack();
    const r = ok(await stack.identity.resolveOrCreate('google', {
      sub: 'g-state-guard-2',
      email: MAIL,
      emailVerified: true,
    }));
    expect(r.userId).toBe(UID);
    expect(r.isNew).toBe(false);
    expect(r.mergedExisting).toBe(true);

    // Пин запрета fall-through в шаг 3: create для не-телефона вставил бы
    // НОВЫЙ user_id (gen_random_uuid) — второй аккаунт.
    expect(await userCount()).toBe(1);

    // Ссылки: старая email + новая google РОВНО ОДИН раз (повторный INSERT
    // дал бы 23505 на UNIQUE(provider, provider_sub) — ловушка 1).
    const ids = await identityRows(UID);
    expect(ids).toHaveLength(2);
    expect(ids.filter((i) => i.provider === 'google')).toHaveLength(1);
    expect(ids.filter((i) => i.provider === 'email')).toHaveLength(1);

    const u = await userRow(UID);
    expect(u.state).toBe('active');
    expect(u.deletion_id).toBeNull();
    expect(u.deleted_at).toBeNull();
    const jobs = await jobRows(GEN2);
    expect(jobs.filter((j) => j.status === 'cancelled')).toHaveLength(2);
    expect(jobs.find((j) => j.resource_type === 'support.stop')!.status).toBe('done');
    expect(await profileRowCount(UID)).toBe(1);
    expect(await balance(UID)).toBe(WELCOME_BONUS);
  });

  it('characterization: blocked → ok как сейчас, state остался blocked, реактивации не было', async () => {
    const PHONE = '79990000204';
    await seedBlockedPhone(PHONE);

    const stack = makeStack();
    const r = ok(await stack.identity.resolveOrCreate('phone', { phone: PHONE }));
    expect(r.userId).toBe(PHONE);
    expect(r.isNew).toBe(false);

    // Гейт-форма: флип blocked был бы самоликвидацией модерации — ok, но
    // строка не тронута, реактивационная транзакция не начиналась.
    expect((await userRow(PHONE)).state).toBe('blocked');
    expect(stack.counters.commits).toBe(0);
    expect(stack.counters.openTx).toBe(0);
    expect(await balance(PHONE)).toBe(0);

    const tracked = stack.events.journal.filter((e) => e.name === 'auth_succeeded');
    expect(tracked).toHaveLength(1);
    expect(tracked[0].props).toMatchObject({ method: 'phone', is_new: false });
  });

  it('characterization: state NULL → ok как сейчас, остался NULL, реактивации не было', async () => {
    const PHONE = '79990000206';
    await pool.query(
      `INSERT INTO user_id (internal_id, primary_phone, welcome_bonus_at)
       VALUES ($1, $2, now() - interval '10 days')`,
      [PHONE, PHONE],
    );
    await pool.query(
      `INSERT INTO user_identities (user_id, provider, provider_sub, email_verified)
       VALUES ($1, 'phone', $2, false)`,
      [PHONE, PHONE],
    );
    await pool.query(
      `INSERT INTO ai_profiles_consolidated (user_id, tokens) VALUES ($1, 0)`,
      [PHONE],
    );

    const stack = makeStack();
    const r = ok(await stack.identity.resolveOrCreate('phone', { phone: PHONE }));
    expect(r.userId).toBe(PHONE);
    expect(r.isNew).toBe(false);

    // FU-T11-2: NULL не лечим — отдельный вопрос владельца.
    expect((await userRow(PHONE)).state).toBeNull();
    expect(stack.counters.commits).toBe(0);
    expect(stack.events.journal.filter((e) => e.name === 'auth_succeeded')).toHaveLength(1);
  });

  it('auth_succeeded записан ПОСЛЕ commit реактивации, signup_completed на входе не пишется', async () => {
    const PHONE = '79990000205';
    const GEN5 = 'd0000000-0000-4000-8000-000000000005';
    await seedDeletedPhone(PHONE, GEN5);
    await seedGenerationJobs(PHONE, GEN5);

    const stack = makeStack();
    ok(await stack.identity.resolveOrCreate('phone', { phone: PHONE }));

    // Журнал: ровно одно событие входа; в момент track() транзакция
    // реактивации уже COMMIT-нута (счётчики сняты синхронно в track).
    expect(stack.events.journal).toHaveLength(1);
    const e = stack.events.journal[0];
    expect(e.name).toBe('auth_succeeded');
    expect(e.userId).toBe(PHONE);
    expect(e.props).toMatchObject({ method: 'phone', is_new: false });
    expect(e.openTx).toBe(0);
    expect(e.commits).toBe(1);
    expect(stack.counters.rollbacks).toBe(0);
    // Вход в существующий (реактивированный) аккаунт — не регистрация.
    expect(stack.events.journal.some((x) => x.name === 'signup_completed')).toBe(false);
  });
});
