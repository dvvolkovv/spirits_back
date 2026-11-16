import { createHash, randomUUID } from 'crypto';
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Pool } from 'pg';
import { ServiceUnavailableException } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { WELCOME_BONUS } from '../identity/identity.service';
import { MIGRATIONS } from '../products/products.service';
import { dryRunAccountDeletion } from './account-deletion.dry-run';
import {
  cleanupSyntheticFixture,
  createSyntheticStack,
  reseedConsumedResources,
  seedSyntheticFixture,
  seedSyntheticHost,
  SYNTHETIC_DELETION_PREFIX,
  SYNTHETIC_HIST_PHONE,
  SYNTHETIC_HOST_ID,
  SYNTHETIC_MAIN_PHONE,
  SYNTHETIC_OTHER_ID,
  SYNTHETIC_RESTART_PHONE,
  type SyntheticFixture,
  type SyntheticStack,
} from './account-deletion.synthetic';

/**
 * Task 22 — синтетическая проверка ПОЛНОГО lifecycle удаления аккаунта
 * против настоящей Postgres: stop → reactivate (отмена поколения) → новое
 * удаление → partial failures на внешних границах → retry → done.
 *
 * Контур честности (ловушка 10 плана): composition root
 * (./account-deletion.synthetic) строит НАСТОЯЩИЕ SchemaService/Planner/
 * Jobs/Runner/Coordinator/Registry/Lifecycle/IdentityService и реальные
 * сервисы модулей (product-цепочка, TgConfigService, VoiceCallService,
 * AvatarService); doubles — ТОЛЬКО на внешних границах (MinIO-транспорт,
 * LiveKit, Attendee, ElevenLabs, календарь-провайдеры, OAuth-провайдеры,
 * Telegram leaveChat, Redis, Neo4j, host-агент), и каждая граница —
 * strict tri-state: успех / инъекция конкретного kind / неизвестная ошибка.
 * Никакого Docker/SSH/платных внешних вызовов: host-агент симулируется
 * через ProvisioningService.completeJob (ловушка 6), Neo4j — тест-дабл
 * (ловушка 7).
 *
 * Отличия от прод-поведения (все — тестовые фикстуры, прод-код не меняется):
 *  - retentionMs передаётся ТОЛЬКО аргументом tick() (ловушка 9);
 *  - purge-задачи планируются на deletedAt+30д, поэтому tick-обёртка
 *    перематывает next_attempt_at (фикстура, прецедент — coordinator pg spec);
 *  - ACCOUNT_DELETION_WORKER_ENABLED выставляется вокруг tick и снимается
 *    в afterEach (ловушка 1);
 *  - coordinator restart моделируется НОВЫМ instance + UPDATE lease_until
 *    в прошлое (ловушка 11);
 *  - reactivate — прод-путь IdentityService.resolveOrCreate (ловушка 5);
 *  - deleteExplicit возвращает Promise<void>, deletion_id читается из БД
 *    (ловушка 2); host-агент тянет stop/purge асинхронно, поэтому удаление
 *    идёт циклом «503 → simulateHostAgent → rewind → повтор» (pull-модель
 *    хоста, прецедент — product-account-deletion.pg.spec.ts).
 */

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `synthetic_deletion_spec_${process.pid}`;

jest.setTimeout(240_000);

/** Все immediate-типы, ожидаемые done после deleteExplicit seeded-аккаунта. */
const ALL_STOP_TYPES = [
  'account.core.immediate',
  'auth-verification.stop',
  'calendar.stop',
  'guest-carry.stop',
  'integration.apple.stop',
  'integration.talerid.stop',
  'integration.zoom.stop',
  'peer.stop',
  'product.stop',
  'referral.stop',
  'retention.stop',
  'support.stop',
  'tasks.stop',
  'telegram.stop',
  'voice.stop',
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

maybe('synthetic deletion lifecycle — полная цепочка против живой БД (Task 22, PG)', () => {
  let admin: Pool;
  let pool: Pool;
  let pg: PgService;
  let stack: SyntheticStack;
  let fixture: SyntheticFixture;
  let tmp: string;
  const savedEnv: NodeJS.ProcessEnv = { ...process.env };
  const deletionIds: string[] = [];
  /** userIds уборки — общие для afterAll и проверки остатка хоста. */
  const cleanupUserIds = (): string[] => [
    fixture.mainUserId,
    fixture.otherUserId,
    fixture.histUserId,
    SYNTHETIC_RESTART_PHONE,
  ];

  const withSearchPath = (url: string): string => {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;
  };

  async function rows(sql: string, params: unknown[] = []): Promise<any[]> {
    return (await pool.query(sql, params as any[])).rows;
  }

  async function one(sql: string, params: unknown[] = []): Promise<any> {
    const r = await rows(sql, params);
    return r[0];
  }

  async function migration(rel: string): Promise<void> {
    await pool.query(readFileSync(join(__dirname, '..', rel), 'utf8'));
  }

  // ---------------------------------------------------------------- helpers

  async function stoppedResources(deletionId: string): Promise<string[]> {
    const r = await rows(
      `SELECT DISTINCT resource_type FROM account_deletion_jobs
        WHERE deletion_id=$1 AND phase='immediate' AND status='done'
        ORDER BY 1`,
      [deletionId],
    );
    return r.map((row) => row.resource_type);
  }

  async function failedKinds(deletionId: string): Promise<string[]> {
    const r = await rows(
      `SELECT DISTINCT last_error_kind FROM account_deletion_jobs
        WHERE deletion_id=$1 AND status='failed' AND last_error_kind IS NOT NULL
        ORDER BY 1`,
      [deletionId],
    );
    return r.map((row) => row.last_error_kind);
  }

  async function unfinishedJobs(deletionId: string): Promise<any[]> {
    return rows(
      `SELECT id, resource_type, status FROM account_deletion_jobs
        WHERE deletion_id=$1 AND status IN ('pending','running','failed')`,
      [deletionId],
    );
  }

  async function jobStatus(id: string): Promise<string | null> {
    const row = await one(`SELECT status FROM account_deletion_jobs WHERE id=$1`, [id]);
    return row?.status ?? null;
  }

  /**
   * Внешние идентификаторы, которые ОБЯЗАНЫ пережить отказный tick:
   * клон ElevenLabs (external_5xx) и продукт на хосте (external_unknown).
   * Их наличие — доказательство, что partial failure остановил стирание,
   * а не пропустил его молча.
   */
  async function externalIdsPresent(userId: string): Promise<boolean> {
    const row = await one(
      `SELECT (
         EXISTS (SELECT 1 FROM user_voice v
                  WHERE v.user_id=$1 AND v.elevenlabs_voice_id IS NOT NULL)
         OR EXISTS (SELECT 1 FROM products p
                     WHERE p.user_id=$1 AND p.purged_at IS NULL)
       ) AS present`,
      [userId],
    );
    return row?.present === true;
  }

  async function newAccountResources(userId: string) {
    const u = await one(
      `SELECT state, deleted_at::text AS deleted_at, deletion_id::text AS deletion_id,
              welcome_bonus_at IS NOT NULL AS has_bonus
         FROM user_id WHERE internal_id=$1`,
      [userId],
    );
    const p = await one(
      `SELECT count(*)::int AS n, COALESCE(max(tokens),0)::bigint AS balance
         FROM ai_profiles_consolidated WHERE user_id=$1`,
      [userId],
    );
    const h = await one(
      `SELECT count(*)::int AS n FROM custom_chat_history
        WHERE session_id LIKE $1 || '\\_%' ESCAPE '\\'`,
      [userId],
    );
    return {
      state: u?.state ?? null,
      deletedAt: u?.deleted_at ?? null,
      deletionId: u?.deletion_id ?? null,
      hasBonus: u?.has_bonus === true,
      profileRows: p?.n ?? 0,
      balance: Number(p?.balance ?? 0),
      historyRows: h?.n ?? 0,
    };
  }

  const EMPTY_RESOURCES = {
    state: null,
    deletedAt: null,
    deletionId: null,
    hasBonus: false,
    profileRows: 0,
    balance: 0,
    historyRows: 0,
  };

  async function sharedResources(otherUserId: string) {
    const calls = await rows(
      `SELECT room_name, status, external_bot_id FROM voice_calls
        WHERE user_id=$1 ORDER BY room_name`,
      [otherUserId],
    );
    const rooms = await rows(
      `SELECT code, owner_user_id, closed_at::text AS closed_at FROM meeting_rooms
        ORDER BY code`,
    );
    const msgs = await one(
      `SELECT count(*)::int AS n FROM peer_messages WHERE sender_id=$1`,
      [otherUserId],
    );
    const convs = await one(
      `SELECT count(*)::int AS n FROM peer_conversations
        WHERE user_a_id=$1 OR user_b_id=$1`,
      [otherUserId],
    );
    const profiles = await one(
      `SELECT count(*)::int AS n, COALESCE(max(tokens),0)::bigint AS tokens
         FROM ai_profiles_consolidated WHERE user_id=$1`,
      [otherUserId],
    );
    return {
      calls,
      rooms,
      messagesFromOther: msgs?.n ?? 0,
      conversations: convs?.n ?? 0,
      profileRows: profiles?.n ?? 0,
      tokens: Number(profiles?.tokens ?? 0),
    };
  }

  async function historicalRow() {
    const u = await one(
      `SELECT state, deleted_at::text AS deleted_at, deletion_id::text AS deletion_id,
              welcome_bonus_at::text AS welcome_bonus_at
         FROM user_id WHERE internal_id=$1`,
      [SYNTHETIC_HIST_PHONE],
    );
    const p = await one(
      `SELECT count(*)::int AS n, COALESCE(max(profile_data::text),'') AS profile_data
         FROM ai_profiles_consolidated WHERE user_id=$1`,
      [SYNTHETIC_HIST_PHONE],
    );
    const h = await one(
      `SELECT count(*)::int AS n, COALESCE(max(content),'') AS content
         FROM custom_chat_history
        WHERE session_id LIKE $1 || '\\_%' ESCAPE '\\'`,
      [SYNTHETIC_HIST_PHONE],
    );
    return { user: u ?? null, profileRows: p?.n ?? 0, profileData: p?.profile_data ?? '', historyRows: h?.n ?? 0, historyContent: h?.content ?? '' };
  }

  async function writeSnapshot() {
    return one(`SELECT
      (SELECT count(*) FROM account_deletion_jobs)::int AS jobs,
      (SELECT count(*) FROM user_id)::int AS users,
      (SELECT count(*) FROM custom_chat_history)::int AS history,
      (SELECT count(*) FROM ai_profiles_consolidated)::int AS profiles,
      (SELECT count(*) FROM products)::int AS products,
      (SELECT count(*) FROM voice_calls)::int AS calls,
      (SELECT count(*) FROM tg_bot_configs)::int AS tg_configs`);
  }

  /**
   * deleteExplicit с симулятором host-агента: product.stop/purge — pull-модель
   * (задание встаёт в очередь, «агент» подтверждает его через
   * ProvisioningService.completeJob). Прод-сигнатура deleteExplicit —
   * Promise<void>; при незавершённых immediate-задачах он бросает 503
   * (EXPLICIT_DELETION_UNAVAILABLE), аккаунт остаётся в удалённом поколении,
   * и повторный вызов продолжает с того же deletion_id. deletion_id читаем
   * из user_id (ловушка 2).
   */
  async function deleteExplicit(userId: string): Promise<{ deletionId: string }> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await stack.lifecycle.deleteExplicit(userId);
        const row = await one(
          `SELECT deletion_id::text AS d FROM user_id WHERE internal_id=$1`,
          [userId],
        );
        if (!row?.d) throw new Error('deletion_id не выставлен после deleteExplicit');
        deletionIds.push(row.d);
        return { deletionId: row.d };
      } catch (error) {
        if (!(error instanceof ServiceUnavailableException)) throw error;
        await stack.simulateHostAgent();
        await pool.query(
          `UPDATE account_deletion_jobs
              SET next_attempt_at = now()
            WHERE user_id = $1 AND status = 'failed'`,
          [userId],
        );
      }
    }
    throw new Error('deleteExplicit не завершился за 8 попыток');
  }

  /**
   * tick-обёртка: env-гейт воркера (ловушка 1) + перемотка next_attempt_at
   * (purge-задачи планируются на +30д, failed — на backoff; rewinding —
   * тестовая фикстура, прецедент coordinator pg spec) + короткий sleep,
   * чтобы deleted_at гарантированно оказался старше retentionMs=1.
   */
  async function tickDeletion(
    deletionId: string,
    options: { retentionMs: number; batchSize?: number },
  ): Promise<void> {
    await sleep(5);
    await pool.query(
      `UPDATE account_deletion_jobs
          SET next_attempt_at = now() - interval '1 second'
        WHERE deletion_id = $1 AND status IN ('pending','failed')`,
      [deletionId],
    );
    // products.purge_after = deleted_at+30д — константа продукта
    // (PRODUCT_DELETION_PURGE_DAYS), аргумент retentionMs на неё не влияет;
    // queuePurgeForProduct ставит host-задание только при purge_after <= now().
    // Перемотка — та же тестовая фикстура, что и next_attempt_at.
    await pool.query(
      `UPDATE products
          SET purge_after = now() - interval '1 day'
        WHERE purged_at IS NULL AND purge_after IS NOT NULL
          AND user_id IN (SELECT user_id FROM account_deletion_jobs
                           WHERE deletion_id = $1)`,
      [deletionId],
    );
    process.env.ACCOUNT_DELETION_WORKER_ENABLED = 'true';
    try {
      await stack.coordinator.tick({
        retentionMs: options.retentionMs,
        batchSize: options.batchSize ?? 2,
      });
    } finally {
      delete process.env.ACCOUNT_DELETION_WORKER_ENABLED;
    }
  }

  /** Retry-фаза: отказы сняты; цикл rewind → tick → host-агент до done. */
  async function retryUntilDone(deletionId: string): Promise<void> {
    for (let round = 0; round < 6; round += 1) {
      stack.failures.clear();
      await tickDeletion(deletionId, { retentionMs: 0 });
      await stack.simulateHostAgent();
      if ((await unfinishedJobs(deletionId)).length === 0) return;
    }
  }

  async function reactivate(phone: string): Promise<void> {
    // Прод-путь (ловушка 5): тот же телефон → та же строка user_id,
    // поколение снимается, незавершённые задачи отменяются.
    const result = await stack.identity.resolveOrCreate('phone', { phone });
    if (result.status !== 'ok') throw new Error(`reactivate: ожидался ok, получен ${result.status}`);
  }

  // ------------------------------------------------------------------- DDL

  beforeAll(async () => {
    tmp = mkdtempSync(join(realpathSync(tmpdir()), 'synthetic-deletion-'));
    process.env.MINIO_ENDPOINT = 'http://127.0.0.1:9000';
    process.env.MINIO_ACCESS_KEY = 'synthetic-access';
    process.env.MINIO_SECRET_KEY = 'synthetic-secret';
    process.env.MINIO_PUBLIC_URL = 'https://minio.test';
    process.env.MINIO_BUCKET_CHAT_FILES = 'linkeon-chat-files';
    process.env.AGENT_URL = 'https://agent.test';
    process.env.BACKEND_URL = 'https://backend.test';
    process.env.PUBLIC_DIR = join(tmp, 'public');
    process.env.PRODUCT_REPOS_DIR = join(tmp, 'product-repos');
    mkdirSync(process.env.PUBLIC_DIR, { recursive: true });
    mkdirSync(process.env.PRODUCT_REPOS_DIR, { recursive: true });

    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({
      connectionString: PG,
      max: 4,
      options: `-c search_path=${SCHEMA}`,
    });

    // ---- Базовые таблицы: дословные копии 001_core_schema.sql
    // (прецедент — identity.reactivation.pg.spec.ts; базовый дамп целиком
    // не грузит ни один спек).

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

    // Настоящие миграции identity: user_identities (+provider_refresh_token),
    // password_hash/signup_method/welcome_bonus_at у user_id.
    await migration('identity/migrations/001_identity_init.sql');

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
          AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
      ALTER SEQUENCE custom_chat_history_id_seq OWNED BY custom_chat_history.id;
      ALTER TABLE ONLY custom_chat_history
          ALTER COLUMN id SET DEFAULT nextval('custom_chat_history_id_seq'::regclass);
    `);

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
          AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
      ALTER SEQUENCE ai_profiles_consolidated_id_seq OWNED BY ai_profiles_consolidated.id;
      ALTER TABLE ONLY ai_profiles_consolidated
          ALTER COLUMN id SET DEFAULT nextval('ai_profiles_consolidated_id_seq'::regclass);
      ALTER TABLE ONLY ai_profiles_consolidated
          ADD CONSTRAINT ai_profiles_consolidated_user_id_key UNIQUE (user_id);
    `);

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
    // (welcome-бонус реактивации идёт через неё).
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
              id, user_id, transaction_type, amount, balance_after,
              description, metadata
          )
          VALUES (
              gen_random_uuid(), p_user_id, p_transaction_type, p_amount,
              v_new_balance, p_description, p_metadata
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

    // ---- Настоящие миграции модулей (execute-SQL адаптеров требует полных
    // таблиц, не только discovery-стабов).

    await migration('chat/action-plans/migrations/001_action_plans.sql');
    await migration('chat/chat-uploads/migrations/001_chat_uploads.sql');
    await migration('custom-agents/migrations/001_custom_agents.sql');
    await migration('custom-agents/migrations/002_owner_user_id_to_text.sql');
    await migration('video/migrations/001_video_jobs.sql');
    await migration('video/migrations/002_composed_video.sql');
    await migration('video/migrations/003_own_voice.sql');
    await migration('video/migrations/004_image_tokens.sql');
    await migration('speech/migrations/001_speech_clips.sql');
    await migration('speech/migrations/002_speech_listens.sql');
    // tg-bot/003 ссылается FK на video_jobs — поэтому после video.
    await migration('tg-bot/migrations/001_tg_bot_schema.sql');
    await migration('tg-bot/migrations/002_tg_bot_custom_agent_fk.sql');
    await migration('tg-bot/migrations/003_tg_bot_video_delivery.sql');
    await migration('tg-bot/migrations/004_tg_bot_answer_watch.sql');
    // voice-call/001 до meeting/001: meeting ALTER-ит voice_calls.
    await migration('voice-call/migrations/001_voice_calls.sql');
    await migration('meeting/migrations/001_meeting_rooms.sql');
    await migration('meeting/migrations/003_drop_room_name_unique.sql');
    await migration('meeting/migrations/004_meet_bot.sql');
    await migration('meeting/migrations/005_zoom_url.sql');
    await migration('voice-call/migrations/002_job_tokens.sql');
    await migration('voice-call/migrations/003_call_tokens.sql');
    await migration('voice-call/migrations/003_voice_call_origin.sql');
    await migration('voice-call/migrations/004_voice_call_end_reason.sql');
    await migration('voice-call/migrations/005_voice_call_participants.sql');
    await migration('voice-avatar/migrations/001_user_voice.sql');
    for (const file of MIGRATIONS) {
      await pool.query(readFileSync(
        join(__dirname, '..', 'products', 'migrations', file),
        'utf8',
      ));
    }
    await migration('tasks/migrations/001_tasks.sql');
    await migration('support/migrations/001_support.sql');
    await migration('support/migrations/002_support_sla.sql');
    // support.purge стирает черновики тикетов алерт-бота — таблица из его
    // миграции (самодостаточна, без FK на support_tickets).
    await migration('alert-bot/migrations/001_alert_bot.sql');
    await migration('peer/migrations/001_peer_tables.sql');
    await migration('retention/migrations/001_retention_email_unsubscribes.sql');
    await migration('devices/migrations/001_user_devices.sql');
    await migration('events/migrations/001_events.sql');
    await migration('backup/migrations/001_profile_backups.sql');
    await migration('routine-push/migrations/001_routine_pushes.sql');
    await migration('routine-push/migrations/002_routines_generalize.sql');
    await migration('push/migrations/001_push_subscriptions.sql');
    await migration('push/migrations/002_push_platform.sql');
    await migration('guest-trial/migrations/001_guest_trial.sql');
    await migration('zoom/migrations/001_zoom.sql');
    await migration('talerid/migrations/001_talerid.sql');

    // ---- referral_*: faithful-копии 001_core_schema.sql (прецедент —
    // referral-account-deletion.pg.spec.ts); миграция referral/001 только
    // расширяет колонки и применяется поверх.
    await pool.query(`
      CREATE TABLE referral_commissions (
        id uuid DEFAULT gen_random_uuid() NOT NULL,
        leader_id uuid NOT NULL,
        payment_id character varying(255),
        referee_phone character varying(20),
        commission_level smallint,
        payment_amount_rub numeric(10,2),
        commission_pct numeric(5,2),
        commission_rub numeric(10,2),
        paid_out boolean DEFAULT false,
        created_at timestamp with time zone DEFAULT now()
      );
      CREATE TABLE referral_leaders (
        id uuid DEFAULT gen_random_uuid() NOT NULL,
        name character varying(255) NOT NULL,
        slug character varying(100) NOT NULL,
        user_phone character varying(20),
        parent_leader_id uuid,
        level smallint DEFAULT 1,
        commission_pct numeric(5,2) DEFAULT 10,
        parent_commission_pct numeric(5,2) DEFAULT 0,
        is_active boolean DEFAULT true,
        created_at timestamp with time zone DEFAULT now(),
        CONSTRAINT referral_leaders_level_check CHECK ((level = ANY (ARRAY[1, 2]))),
        CONSTRAINT referral_leaders_slug_check CHECK (((slug)::text ~ '^[a-z0-9-]+$'::text))
      );
      CREATE TABLE referral_referees (
        id uuid DEFAULT gen_random_uuid() NOT NULL,
        referee_phone character varying(20) NOT NULL,
        leader_id uuid NOT NULL,
        registered_at timestamp with time zone DEFAULT now()
      );
      ALTER TABLE ONLY referral_referees
        ADD CONSTRAINT referral_referees_referee_phone_key UNIQUE (referee_phone);
      CREATE TABLE IF NOT EXISTS referral_token_payouts (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        leader_id uuid NOT NULL,
        user_phone varchar(20) NOT NULL,
        rub numeric(10,2) NOT NULL,
        tokens integer NOT NULL,
        rate integer NOT NULL,
        commission_ids uuid[] NOT NULL,
        created_at timestamptz DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS referral_withdrawals (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        leader_id uuid NOT NULL,
        user_phone varchar(20) NOT NULL,
        amount_rub numeric(10,2) NOT NULL,
        method varchar(20) NOT NULL,
        requisites text NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'pending',
        commission_ids uuid[] NOT NULL,
        created_at timestamptz DEFAULT now(),
        processed_at timestamptz,
        processed_by varchar(40)
      );
    `);
    // Расширения ReferralService.onModuleInit (referral.service.ts:246,252) —
    // прод-порядок: base-таблицы → инлайновые ALTER-ы сервиса → migrations/,
    // где 002 читает bonus_tokens и referral_token_payouts.
    await pool.query(`
      ALTER TABLE referral_referees ADD COLUMN IF NOT EXISTS bonus_tokens integer NOT NULL DEFAULT 0;
      ALTER TABLE referral_leaders ADD COLUMN IF NOT EXISTS payout_notified boolean NOT NULL DEFAULT false;
    `);
    // Task 17C: phone-колонки выплат/выводов расширены до varchar(64) —
    // deletion-scoped alias 'deleted:<deletionId>' (44 символа) в varchar(20)
    // не помещается (копия guarded DO-блоков referral.service.ts:212-241).
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'referral_token_payouts'
                      AND column_name = 'user_phone'
                      AND character_maximum_length IS NOT NULL
                      AND character_maximum_length < 64) THEN
          ALTER TABLE referral_token_payouts ALTER COLUMN user_phone TYPE varchar(64);
        END IF;
      END $$;
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'referral_withdrawals'
                      AND column_name = 'user_phone'
                      AND character_maximum_length IS NOT NULL
                      AND character_maximum_length < 64) THEN
          ALTER TABLE referral_withdrawals ALTER COLUMN user_phone TYPE varchar(64);
        END IF;
      END $$;
    `);
    await migration('referral/migrations/001_user_id_to_text.sql');
    await migration('referral/migrations/002_backfill_offledger_accruals.sql');

    // ---- Таблицы без модульных миграций: копии из 001_core_schema.sql /
    // inline-DDL сервисов (calendar.service.ts, linkeon-tasks.service.ts,
    // day-framing.store.ts, trip.service.ts).
    await pool.query(`
      CREATE TABLE generated_images (
        id serial PRIMARY KEY,
        user_id text NOT NULL,
        prompt text NOT NULL DEFAULT '',
        image_url text NOT NULL,
        tokens_spent integer DEFAULT 5000,
        created_at timestamptz DEFAULT now()
      );
      CREATE TABLE short_codes (
        phone character varying(20),
        short_code character varying(6),
        created_at timestamp with time zone DEFAULT now()
      );
      CREATE TABLE contact_requests (
        id serial PRIMARY KEY,
        requester_id integer NOT NULL,
        target_id integer NOT NULL,
        message text,
        status character varying(16) DEFAULT 'pending' NOT NULL,
        created_at timestamp with time zone DEFAULT now() NOT NULL,
        resolved_at timestamp with time zone
      );
      CREATE TABLE calendar_connections (
        user_id TEXT NOT NULL, provider TEXT NOT NULL, base_url TEXT NOT NULL,
        username TEXT NOT NULL, secret_enc TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        collection_url TEXT, todo_collection_url TEXT,
        PRIMARY KEY (user_id, provider)
      );
      CREATE TABLE calendar_proposals (
        id UUID PRIMARY KEY,
        user_id TEXT NOT NULL,
        event JSONB NOT NULL,
        connected BOOLEAN NOT NULL,
        conflicts JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        kind TEXT NOT NULL DEFAULT 'event',
        status TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE trip_calendars (
        user_id TEXT NOT NULL,
        kind    TEXT NOT NULL,
        url     TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        PRIMARY KEY (user_id, kind)
      );
      CREATE TABLE linkeon_tasks (
        uid        UUID PRIMARY KEY,
        user_id    TEXT NOT NULL,
        title      TEXT NOT NULL,
        due        TIMESTAMPTZ,
        deadline   TIMESTAMPTZ,
        note       TEXT,
        recurrence JSONB,
        status     TEXT NOT NULL DEFAULT 'pending',
        done_at    TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE day_framing (
        user_id text NOT NULL,
        day date NOT NULL,
        kind text NOT NULL,
        text text NOT NULL,
        action_json jsonb,
        facts_hash text NOT NULL,
        generated_at timestamptz NOT NULL DEFAULT now(),
        dismissed boolean NOT NULL DEFAULT false,
        PRIMARY KEY (user_id, day, kind)
      );
    `);

    // ---- Пустые stub-таблицы discovery (прецедент — dry-run.spec):
    // строк нет → задач эти домены не дают.
    await pool.query(`
      CREATE TABLE smm_campaign (
        id uuid PRIMARY KEY, user_id text, is_linkeon_official boolean DEFAULT false
      );
      CREATE TABLE smm_social_account (user_id text);
      CREATE TABLE smm_oauth_state (user_id text);
      CREATE TABLE smm_billing_ledger (user_id text);
      CREATE TABLE smm_premium_generation (user_id text);
      CREATE TABLE smm_publication (video_id uuid, external_post_id text);
      CREATE TABLE smm_video (id uuid PRIMARY KEY, scenario_id uuid);
      CREATE TABLE smm_scenario (id uuid PRIMARY KEY, campaign_id uuid);
    `);

    // ---- account_deletion_jobs + deleted_at/deletion_id — НАСТОЯЩЕЙ
    // AccountDeletionSchemaService (composition root), а не readFileSync:
    // заодно проверка идемпотентности прод-миграции.
    process.env.DATABASE_URL = withSearchPath(PG!);
    pg = new PgService();
    await pg.onModuleInit();

    stack = createSyntheticStack(pg);
    await stack.schema.onModuleInit();
    stack.registry.assertReady();

    fixture = await seedSyntheticFixture(stack);
  });

  afterAll(async () => {
    try {
      if (stack && fixture) {
        await cleanupSyntheticFixture(stack, { deletionIds, userIds: cleanupUserIds() });
      }
    } catch {
      // одноразовая схема всё равно уходит CASCADE-ом ниже
    }
    if (pg) await pg.onModuleDestroy();
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    process.env = { ...savedEnv };
  });

  afterEach(() => {
    // Ловушка 1: env-гейт воркера не должен переживать тест.
    delete process.env.ACCOUNT_DELETION_WORKER_ENABLED;
  });

  // ------------------------------------------------------------------ tests

  it('composition root: состав реестра как в проде, assertReady зелёный (T22.6)', () => {
    // Skip-only типы ('calendar.external', 'video.provider') не зарегистрированы
    // (стабы убраны в T22.6): assertReady их не требует, санитайзер отклоняет
    // JOB'ы таких типов, а discoverer'ы эмитируют только skips.
    expect(() => stack.registry.assertReady()).not.toThrow();
    // Внешних вызовов до начала сценария не было.
    expect(stack.failures.totalCalls()).toBe(0);
  });

  it('dry-run перед apply: нулевой write/external count (ловушка 13)', async () => {
    const before = await writeSnapshot();
    const summary = await dryRunAccountDeletion(stack.db, { retentionMs: 0 });
    expect(typeof summary.accounts).toBe('number');
    expect(summary.jobsByType).toBeDefined();
    expect(await writeSnapshot()).toEqual(before);
    expect(stack.failures.totalCalls()).toBe(0);
  });

  it('synthetic: stop → reactivate cancel → новое удаление → partial failures → retry → done', async () => {
    // --- Фаза 1: явное удаление, все immediate-задачи done.
    const first = await deleteExplicit(fixture.mainUserId);
    expect(first.deletionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(await stoppedResources(first.deletionId)).toEqual(ALL_STOP_TYPES);
    expect(await externalIdsPresent(fixture.mainUserId)).toBe(true);

    // --- Фаза 2: реактивация прод-путём отменяет поколение; прогон
    // runAccount по старому deletionId не касается нового аккаунта.
    await reactivate(SYNTHETIC_MAIN_PHONE);
    await stack.runner.runAccount(first.deletionId);
    const revived = await newAccountResources(fixture.mainUserId);
    expect(revived).not.toEqual(EMPTY_RESOURCES);
    expect(revived.state).toBe('active');
    expect(revived.deletionId).toBeNull();
    expect(revived.deletedAt).toBeNull();
    expect(revived.profileRows).toBe(1);
    // T20-M1: отметка бонуса пережила удаление — повторная регистрация тем же
    // номером второй приветственный бонус не получает, баланс нового аккаунта 0.
    expect(revived.hasBonus).toBe(true);
    expect(revived.balance).toBe(0);
    expect(await unfinishedJobs(first.deletionId)).toHaveLength(0);
    // Незавершённые задачи первого поколения отменены реактивацией.
    const cancelled = await one(
      `SELECT count(*)::int AS n FROM account_deletion_jobs
        WHERE deletion_id=$1 AND status='cancelled'`,
      [first.deletionId],
    );
    expect(cancelled.n).toBeGreaterThan(0);

    // Новый аккаунт снова обрастает файлом переписки — второе поколение
    // обязано спланировать chat-file.purge заново (recapture core). Ресев
    // ресурсов, израсходованных первым поколением (user_identities удалены
    // account.core.immediate, звонки прерваны voice.stop) — иначе discovery
    // integration.apple.stop/voice.stop второго поколения законно пуст.
    await stack.seedHistoryRow(fixture.mainUserId, 'synthetic-deletion-second');
    await reseedConsumedResources(stack, fixture.mainUserId);

    // --- Фаза 3: второе удаление — НОВЫЙ UUID поколения.
    const second = await deleteExplicit(fixture.mainUserId);
    expect(second.deletionId).not.toBe(first.deletionId);
    expect(await stoppedResources(second.deletionId)).toEqual(ALL_STOP_TYPES);

    // --- Фаза 4: partial failures на четырёх внешних границах.
    stack.failures
      .inject('minio', 'timeout')
      .inject('host', 'external_unknown')
      .inject('elevenlabs', 'external_5xx')
      .inject('calendar', 'external_5xx');
    await tickDeletion(second.deletionId, { retentionMs: 1, batchSize: 2 });
    expect(await failedKinds(second.deletionId)).toEqual(
      expect.arrayContaining(['timeout', 'external_unknown', 'external_5xx']),
    );
    // Внешние идентификаторы пережили отказ: стирание НЕ подтверждено.
    expect(await externalIdsPresent(fixture.mainUserId)).toBe(true);
    expect((await unfinishedJobs(second.deletionId)).length).toBeGreaterThan(0);

    // --- Фаза 5: retry без отказов доделывает всё, чужое не тронуто.
    await retryUntilDone(second.deletionId);
    expect(await unfinishedJobs(second.deletionId)).toHaveLength(0);
    expect(await externalIdsPresent(fixture.mainUserId)).toBe(false);
    expect(await sharedResources(fixture.otherUserId)).toEqual(fixture.allSharedResources);
    const inboxOwners = await rows(
      `SELECT idempotency_key FROM meeting_webhook_events
        WHERE idempotency_key LIKE 'synthetic-inbox-%' ORDER BY idempotency_key`,
    );
    expect(inboxOwners).toEqual([
      { idempotency_key: `synthetic-inbox-${fixture.otherUserId}` },
    ]);

    // T22-Q3: recapture второго поколения — прямой assert, а не комментарий.
    // chat-file.purge gen2 обязан существовать (посев строки с файлом перед
    // фазой 3) и быть доделанным retry-ем; MinIO-граница при этом реально
    // вызывалась (в фазе 4 она же отказывала timeout-ом).
    const chatPurge2 = await rows(
      `SELECT status FROM account_deletion_jobs
        WHERE deletion_id=$1 AND resource_type='chat-file.purge'`,
      [second.deletionId],
    );
    expect(chatPurge2.length).toBeGreaterThan(0);
    expect(chatPurge2.every((job) => job.status === 'done')).toBe(true);
    expect(stack.failures.calls('minio')).toBeGreaterThan(0);

    // T22-Q2: финальное состояние ОСНОВНОГО аккаунта после gen2 — прямой
    // assert: tombstone (state='deleted'), баланс обнулён, история переписки
    // стерта, canary-контент второго поколения не пережил purge.
    const finalMain = await newAccountResources(fixture.mainUserId);
    expect(finalMain.state).toBe('deleted');
    expect(finalMain.balance).toBe(0);
    expect(finalMain.historyRows).toBe(0);
    const canary = await one(
      `SELECT count(*)::int AS n FROM custom_chat_history
        WHERE content LIKE '%synthetic-deletion-second%'`,
    );
    expect(canary.n).toBe(0);
  });

  it('historical deleted контрольный row остаётся нетронутым (ловушка 14)', async () => {
    expect(await historicalRow()).toEqual(fixture.historicalControl);
  });

  it('coordinator restart: новый instance подбирает задачу с истёкшим lease (ловушка 11)', async () => {
    const restart = await stack.seedMinimalAccount(SYNTHETIC_RESTART_PHONE);
    const { deletionId } = await deleteExplicit(restart.userId);

    // Фикстура «прошлого restart-а»: pending-задача переведена в running
    // с истёкшим lease — так выглядит работа воркера после его смерти.
    const victim = await one(
      `SELECT id::text AS id FROM account_deletion_jobs
        WHERE deletion_id=$1 AND status='pending' AND resource_type='contacts.purge'`,
      [deletionId],
    );
    expect(victim?.id).toBeTruthy();
    await pool.query(
      `UPDATE account_deletion_jobs
          SET status='running',
              lease_until = now() - interval '1 minute',
              next_attempt_at = now() - interval '1 minute'
        WHERE id=$1`,
      [victim.id],
    );

    const restarted = stack.makeCoordinator();
    process.env.ACCOUNT_DELETION_WORKER_ENABLED = 'true';
    try {
      await sleep(5);
      await restarted.tick({ retentionMs: 0, batchSize: 2 });
    } finally {
      delete process.env.ACCOUNT_DELETION_WORKER_ENABLED;
    }
    expect(await jobStatus(victim.id)).toBe('done');

    // Остальные purge-задачи доделывает обычный tick.
    await retryUntilDone(deletionId);
    expect(await unfinishedJobs(deletionId)).toHaveLength(0);
  });

  it('simulateHostAgent подтверждает только синтетические продукты (T22-Q5)', async () => {
    // Чужой аккаунт стенда вне синтетического scope: его queued-задание
    // симулятор host-агента забирать не имеет права — иначе синтетика
    // подтверждала бы job'ы РЕАЛЬНЫХ продуктов живой базы.
    const foreignUser = 'u-synthetic-foreign-host';
    const foreignProduct = randomUUID();
    const ownProduct = randomUUID();

    const seedQueuedJob = async (productId: string, userId: string, slug: string) => {
      await pool.query(
        `INSERT INTO products
           (id, user_id, name, slug, kind, status, checkout_path, runner_token_hash, host_id)
         VALUES ($1,$2,'Synthetic Product',$3,'site','running','/product',$4,$5)`,
        [
          productId,
          userId,
          slug,
          createHash('sha256').update(`runner-${productId}`).digest('hex'),
          SYNTHETIC_HOST_ID,
        ],
      );
      await pool.query(
        `INSERT INTO product_provision_jobs (product_id, kind, status)
         VALUES ($1,'sleep','queued')`,
        [productId],
      );
    };

    try {
      await seedQueuedJob(foreignProduct, foreignUser, `${SYNTHETIC_DELETION_PREFIX}foreign-host`);
      await seedQueuedJob(ownProduct, fixture.mainUserId, `${SYNTHETIC_DELETION_PREFIX}own-host`);

      await stack.simulateHostAgent();

      const foreign = await one(
        `SELECT status FROM product_provision_jobs WHERE product_id=$1`,
        [foreignProduct],
      );
      const own = await one(
        `SELECT status FROM product_provision_jobs WHERE product_id=$1`,
        [ownProduct],
      );
      // Чужое задание остаётся в очереди — подтверждение строго по scope.
      expect(foreign.status).toBe('queued');
      // Синтетическое — забрано и подтверждено через completeJob (sleep → done).
      expect(own.status).toBe('done');
    } finally {
      await pool.query(
        `DELETE FROM product_provision_jobs WHERE product_id = ANY($1::uuid[])`,
        [[foreignProduct, ownProduct]],
      );
      await pool.query(
        `DELETE FROM products WHERE id = ANY($1::uuid[])`,
        [[foreignProduct, ownProduct]],
      );
    }
  });

  it('посев хоста закрывает для новых уже существующий синтетический хост', async () => {
    // Строка хоста могла остаться от прерванного прогона и быть открытой для
    // новых (accepts_new = true — например, после ручной правки). Посев
    // обязан закрыть её, а не молча оставить как есть: иначе живой API
    // стенда выберет фиктивную машину для чужого нового продукта.
    //
    // Независимость от порядка: строка заводится здесь же upsert'ом (была ли
    // она после beforeAll или её уже убрал тест уборки ниже — всё равно), а
    // finally возвращает её в то состояние, в каком её оставляет посев
    // beforeAll (хост есть, accepts_new = false). Поэтому тест уборки после
    // этого видит прежнее предусловие, и падение здесь не роняет его.
    try {
      await pool.query(
        `INSERT INTO product_hosts (id, ssh_target, public_ip, domain_suffix, agent_token_hash, capacity, audience, accepts_new)
         VALUES ($1,'root@10.50.0.1','10.50.0.1','c.linkeon.io',$2,20,'clients',true)
         ON CONFLICT (id) DO UPDATE SET accepts_new = true`,
        [SYNTHETIC_HOST_ID, createHash('sha256').update(randomUUID()).digest('hex')],
      );
      expect(await one(
        `SELECT accepts_new FROM product_hosts WHERE id=$1`,
        [SYNTHETIC_HOST_ID],
      )).toEqual({ accepts_new: true });

      await seedSyntheticHost(stack.pg);

      expect(await one(
        `SELECT accepts_new FROM product_hosts WHERE id=$1`,
        [SYNTHETIC_HOST_ID],
      )).toEqual({ accepts_new: false });
    } finally {
      await pool.query(
        `UPDATE product_hosts SET accepts_new = false WHERE id=$1`,
        [SYNTHETIC_HOST_ID],
      );
    }
  });

  // ПОСЛЕДНИЙ тест блока: он сам вызывает cleanup. afterAll вызовет его ещё
  // раз — уборка идемпотентна (только DELETE … WHERE, повтор удаляет ноль строк).
  it('cleanup убирает синтетический хост и всё, что на нём, из живой схемы', async () => {
    // Без этой проверки опечатка в SQL уборки хоста осталась бы незамеченной:
    // cleanup глотает ошибки по группам, afterAll глотает ошибку целиком,
    // а схема уходит DROP SCHEMA … CASCADE.
    //
    // Посев — чтобы каждая ветка уборки хоста имела что удалять:
    //  - продукт ЧУЖОГО пользователя (вне userIds уборки) на синтетическом
    //    хосте: его, его задание и строку журнала убирают только ветки
    //    по host_id, а не по user_id;
    //  - строка product_actions с тем же чужим user_id: если бы products
    //    удалялись раньше журнала, ON DELETE SET NULL отвязал бы её, и она
    //    осталась бы — проверяется ниже по id;
    //  - отметка агента: цепочка synthetic её не заводит, без посева
    //    DELETE из product_host_agent ничего бы не проверял.
    const count = async (sql: string, params: unknown[] = []): Promise<number> =>
      (await one(sql, params)).n;
    const residueUser = 'u-synthetic-foreign-host-residue';
    const residueProduct = randomUUID();
    await pool.query(
      `INSERT INTO products
         (id, user_id, name, slug, kind, status, checkout_path, runner_token_hash, host_id)
       VALUES ($1,$2,'Synthetic Product',$3,'site','running','/product',$4,$5)`,
      [
        residueProduct,
        residueUser,
        `${SYNTHETIC_DELETION_PREFIX}residue-host`,
        createHash('sha256').update(`runner-${residueProduct}`).digest('hex'),
        SYNTHETIC_HOST_ID,
      ],
    );
    await pool.query(
      `INSERT INTO product_provision_jobs (product_id, kind, status)
       VALUES ($1,'sleep','queued')`,
      [residueProduct],
    );
    const action = await one(
      `INSERT INTO product_actions (user_id, product_id, kind, status, channel)
       VALUES ($1,$2,'purge','done','system')
       RETURNING id::text AS id`,
      [residueUser, residueProduct],
    );
    await pool.query(
      `INSERT INTO product_host_agent (host_id, seen_at) VALUES ($1, now())
       ON CONFLICT (host_id) DO NOTHING`,
      [SYNTHETIC_HOST_ID],
    );

    // Предусловие: до уборки хост и всё на нём реально есть в схеме —
    // иначе нули ниже ничего бы не доказывали.
    const host = await one(
      `SELECT accepts_new FROM product_hosts WHERE id=$1`,
      [SYNTHETIC_HOST_ID],
    );
    expect(host).toEqual({ accepts_new: false });
    const hostProducts: string[] = (
      await rows(`SELECT id::text AS id FROM products WHERE host_id=$1`, [SYNTHETIC_HOST_ID])
    ).map((row) => row.id);
    expect(hostProducts).toContain(residueProduct);
    expect(await count(
      `SELECT count(*)::int AS n FROM product_provision_jobs WHERE product_id = ANY($1::uuid[])`,
      [hostProducts],
    )).toBeGreaterThan(0);
    expect(await count(
      `SELECT count(*)::int AS n FROM product_actions WHERE id=$1`,
      [action.id],
    )).toBe(1);
    expect(await count(
      `SELECT count(*)::int AS n FROM product_host_agent WHERE host_id=$1`,
      [SYNTHETIC_HOST_ID],
    )).toBe(1);

    await cleanupSyntheticFixture(stack, { deletionIds, userIds: cleanupUserIds() });

    expect(await count(
      `SELECT count(*)::int AS n FROM product_hosts WHERE id=$1`,
      [SYNTHETIC_HOST_ID],
    )).toBe(0);
    expect(await count(
      `SELECT count(*)::int AS n FROM product_host_agent WHERE host_id=$1`,
      [SYNTHETIC_HOST_ID],
    )).toBe(0);
    expect(await count(
      `SELECT count(*)::int AS n FROM products WHERE host_id=$1 OR id = ANY($2::uuid[])`,
      [SYNTHETIC_HOST_ID, hostProducts],
    )).toBe(0);
    expect(await count(
      `SELECT count(*)::int AS n FROM product_provision_jobs WHERE product_id = ANY($1::uuid[])`,
      [hostProducts],
    )).toBe(0);
    expect(await count(
      `SELECT count(*)::int AS n FROM product_actions WHERE id=$1`,
      [action.id],
    )).toBe(0);
    // Общий хост product pg spec synthetic не заводит и не оставляет.
    expect(await count(
      `SELECT count(*)::int AS n FROM product_hosts WHERE id='host-shared'`,
    )).toBe(0);
  });
});
