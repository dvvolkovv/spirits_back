import { BadRequestException } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import axios from 'axios';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import { DELETION_DISCOVERERS } from '../account-deletion/account-deletion.catalog';
import {
  DeletionCancelledError,
  DeletionRetryError,
  safeDeletionJobSnapshot,
} from '../account-deletion/account-deletion.safe';
import type {
  DeletionAccount,
  DeletionExecution,
  DeletionJobRow,
} from '../account-deletion/account-deletion.types';
import { ReferralModule } from './referral.module';
import { ReferralService } from './referral.service';
import {
  discoverReferralDeletion,
  ReferralAccountDeletionAdapter,
} from './referral-account-deletion.adapter';

jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));

/**
 * Task 17C — referral: выплаты останавливаются, ledger сохраняется,
 * идентичность обезличивается deletion-scoped alias.
 *
 * PG-часть обязательна: alias 'deleted:<deletionId>' — 44 символа, а телефонные
 * колонки referral-схемы исторически varchar(20). Три колонки
 * (referral_leaders.user_phone, referral_referees.referee_phone,
 * referral_commissions.referee_phone) уже расширены до text миграцией
 * migrations/001_user_id_to_text.sql; две инлайновые
 * (referral_token_payouts.user_phone, referral_withdrawals.user_phone)
 * расширяет до varchar(64) onModuleInit ReferralService. Спек поднимает
 * таблицы В ИСХОДНОЙ форме varchar(20) (с настоящими CHECK/UNIQUE из
 * 001_core_schema.sql) и прогоняет путь расширения через onModuleInit,
 * чтобы алиасинг реально прошёл через widening, а не мимо него.
 *
 * Семантика (план):
 *  - referral.stop деактивирует лидера (is_active=false) — register/withdraw/
 *    payout и SMS-уведомления отсекаются strict-предикатом;
 *  - referral.purge при наличии pending-заявки на вывод отказывается
 *    DeletionRetryError('external_unknown') и НЕ меняет ничего: обязательство
 *    (сумма, реквизиты, статус) сохраняется до решения админа;
 *  - settled-состояние (paid/rejected): один alias заменяет телефон в пяти
 *    колонках, name→'', slug→'deleted-<deletionId>' (проходит CHECK
 *    '^[a-z0-9-]+$'), requisites→''; payment_id, commission_ids, все суммы,
 *    paid_out, статусы и token_transactions НЕ меняются;
 *  - повторная регистрация телефона не упирается в старый UNIQUE referee.
 */

const USER = 'u-del-phone';
const OTHER = 'u-other-phone';
const THIRD = 'u-third-phone';
const NUM_LEADER = '10000000001'; // явно фейковый номер (не боевой диапазон)
const LONE_CANARY = 'СЕКРЕТ-РЕКВИЗИТ-НЕ-ЛОГИРОВАТЬ';
const SECOND_CANARY = 'СБП-РЕКВИЗИТ-ВТОРОЙ-КАНАРЕЙКА';
const deletionId = '7d1e6a2c-3b4f-4c5d-9e6a-0f1a2b3c4d5e';
const ALIAS = `deleted:${deletionId}`;
const DELETED_AT = new Date('2026-11-01T00:00:00.000Z');
const account: DeletionAccount = { userId: USER, deletionId, deletedAt: DELETED_AT };

// ==================== Discovery / wiring (без PG) ====================

class FakeGenDb {
  readonly queries: Array<{ sql: string; params: any[] }> = [];
  constructor(private genOk: boolean) {}
  async query(sql: string, params: any[] = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    this.queries.push({ sql: s, params });
    if (s.startsWith('SELECT 1 FROM user_id')) {
      return this.genOk ? { rows: [{ n: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    throw new Error(`unexpected query: ${s}`);
  }
}

function jobRow(
  resourceType: 'referral.stop' | 'referral.purge',
  overrides: Partial<DeletionJobRow> = {},
): DeletionJobRow {
  return {
    id: `job-${resourceType}`,
    deletionId,
    userId: USER,
    resourceType,
    resourceKey: 'referral',
    phase: resourceType === 'referral.stop' ? 'immediate' : 'purge',
    payload: {},
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date('2026-12-14T00:00:00Z'),
    leaseUntil: new Date('2026-12-14T01:00:00Z'),
    lastErrorKind: null,
    ...overrides,
  };
}

describe('discoverReferralDeletion — stop+purge, пустые payload (Task 17C)', () => {
  it('два jobа: referral.stop immediate и referral.purge purge; sanitizer плана проходит', async () => {
    const db = new FakeGenDb(true);

    const plan = await discoverReferralDeletion({ db, account, origin: 'explicit' });

    expect(plan.jobs).toEqual([
      { resourceType: 'referral.stop', resourceKey: 'referral', phase: 'immediate', payload: {} },
      { resourceType: 'referral.purge', resourceKey: 'referral', phase: 'purge', payload: {} },
    ]);
    expect(plan.skips).toEqual([]);
    const json = JSON.stringify(plan.jobs);
    expect(json).not.toContain(USER);
    expect(json).not.toContain(LONE_CANARY);
    for (const job of plan.jobs) {
      expect(() => safeDeletionJobSnapshot(job, USER)).not.toThrow();
    }
    // Discovery НЕ читает referral-таблицы — только generation gate
    // (суммы/реквизиты в план не поднимаются).
    expect(db.queries.every((q) => q.sql.startsWith('SELECT 1 FROM user_id'))).toBe(true);
  });

  it('reactivation (поколение не совпало) — план пустой', async () => {
    const db = new FakeGenDb(false);

    const plan = await discoverReferralDeletion({ db, account, origin: 'explicit' });

    expect(plan).toEqual({ jobs: [], skips: [] });
  });
});

describe('wiring referral.stop/referral.purge (Task 17C)', () => {
  it('adapter регистрирует referral.stop и referral.purge, ReferralModule его провайдит', () => {
    const registry = { register: jest.fn() } as any;
    const adapter = new ReferralAccountDeletionAdapter(registry);
    expect(adapter.resourceTypes).toEqual(['referral.stop', 'referral.purge']);
    adapter.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(adapter);

    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, ReferralModule) ?? []).flat(Infinity);
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ReferralModule) ?? [];
    expect(imports.filter((item: unknown) => item === AccountDeletionModule)).toHaveLength(1);
    expect(providers.filter((item: unknown) => item === ReferralAccountDeletionAdapter)).toHaveLength(1);
  });

  it('catalog содержит discoverReferralDeletion ровно один раз', () => {
    expect(
      DELETION_DISCOVERERS.filter((item) => item === discoverReferralDeletion),
    ).toHaveLength(1);
  });

  it('чужой resourceType — отказ до любой записи', async () => {
    const db = new FakeGenDb(true);
    const adapter = new ReferralAccountDeletionAdapter(new AccountDeletionRegistry());
    const ctx: DeletionExecution = { db, assertCurrent: jest.fn(async () => undefined) };

    await expect(
      adapter.execute(jobRow('referral.purge', { resourceType: 'avatar.purge' }), ctx),
    ).rejects.toThrow('unsupported_deletion_resource');
    expect(ctx.assertCurrent).not.toHaveBeenCalled();
    expect(db.queries).toHaveLength(0);
  });
});

// ==================== PG-часть ====================

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `referral_acct_del_spec_${process.pid}`;

maybe('referral account deletion against PostgreSQL (Task 17C)', () => {
  jest.setTimeout(60_000);

  let admin: Pool;
  let pool: Pool;
  let adapter: ReferralAccountDeletionAdapter;

  function makeCtx(): DeletionExecution & { assertCurrent: jest.Mock } {
    return {
      db: { query: (sql: string, params?: unknown[]) => pool.query(sql, params as any[]) },
      assertCurrent: jest.fn(async () => undefined),
    };
  }

  function makeService(): ReferralService {
    return new ReferralService({
      query: (sql: string, params?: any[]) => pool.query(sql, params),
      getClient: () => pool.connect(),
    } as any);
  }

  async function rows(sql: string, params: any[] = []): Promise<any[]> {
    return (await pool.query(sql, params)).rows;
  }

  async function seedUser(id: string, state: 'active' | 'deleted' = 'active', delId: string | null = null) {
    await pool.query(
      `INSERT INTO user_id (internal_id,state,deleted_at,deletion_id,welcome_bonus_at)
       VALUES ($1,$2,$3,$4,now())`,
      [id, state, state === 'deleted' ? DELETED_AT : null, delId],
    );
  }

  async function seedLeader(phone: string, slug: string, name = 'Имя Лидера'): Promise<string> {
    const r = await pool.query(
      `INSERT INTO referral_leaders (name, slug, user_phone) VALUES ($1,$2,$3) RETURNING id`,
      [name, slug, phone],
    );
    return r.rows[0].id;
  }

  async function seedReferee(phone: string, leaderId: string): Promise<string> {
    const r = await pool.query(
      `INSERT INTO referral_referees (referee_phone, leader_id) VALUES ($1,$2) RETURNING id`,
      [phone, leaderId],
    );
    return r.rows[0].id;
  }

  async function seedCommission(
    leaderId: string,
    refereePhone: string,
    level: number,
    amountRub: number,
    paidOut: boolean,
    paymentId: string | null = null,
  ): Promise<string> {
    const r = await pool.query(
      `INSERT INTO referral_commissions
         (leader_id, payment_id, referee_phone, commission_level,
          payment_amount_rub, commission_pct, commission_rub, paid_out)
       VALUES ($1,$2,$3,$4,$5,10,$6,$7) RETURNING id`,
      [leaderId, paymentId, refereePhone, level, amountRub,
        Math.round(amountRub * 0.1 * 100) / 100, paidOut],
    );
    return r.rows[0].id;
  }

  async function seedPayout(
    leaderId: string, phone: string, rub: number, tokens: number, rate: number,
    commissionIds: string[] = [],
  ): Promise<string> {
    const r = await pool.query(
      `INSERT INTO referral_token_payouts (leader_id, user_phone, rub, tokens, rate, commission_ids)
       VALUES ($1,$2,$3,$4,$5,$6::uuid[]) RETURNING id`,
      [leaderId, phone, rub, tokens, rate, commissionIds],
    );
    return r.rows[0].id;
  }

  async function seedWithdrawal(
    leaderId: string, phone: string, amountRub: number, status: string,
    requisites: string, commissionIds: string[] = [],
  ): Promise<string> {
    const settled = status !== 'pending';
    const r = await pool.query(
      `INSERT INTO referral_withdrawals
         (leader_id, user_phone, amount_rub, method, requisites, status,
          commission_ids, processed_at, processed_by)
       VALUES ($1,$2,$3,'sbp',$4,$5,$6::uuid[],$7,$8) RETURNING id`,
      [leaderId, phone, amountRub, requisites, status, commissionIds,
        settled ? new Date('2026-10-15T00:00:00Z') : null,
        settled ? 'adm-fake' : null],
    );
    return r.rows[0].id;
  }

  /** Финансовый срез: всё, что purge ОБЯЗАН сохранить (без PII-колонок). */
  async function financialSnapshot(): Promise<string> {
    const commissions = await rows(
      `SELECT id, leader_id, payment_id, commission_level,
              payment_amount_rub::text AS payment_amount_rub,
              commission_pct::text AS commission_pct,
              commission_rub::text AS commission_rub, paid_out, created_at
         FROM referral_commissions ORDER BY id`);
    const payouts = await rows(
      `SELECT id, leader_id, rub::text AS rub, tokens, rate, commission_ids, created_at
         FROM referral_token_payouts ORDER BY id`);
    const withdrawals = await rows(
      `SELECT id, leader_id, amount_rub::text AS amount_rub, method, commission_ids,
              status, created_at, processed_at, processed_by
         FROM referral_withdrawals ORDER BY id`);
    const ledger = await rows(
      `SELECT id, user_id, transaction_type, amount, balance_after, description, metadata, created_at
         FROM token_transactions ORDER BY id`);
    return JSON.stringify({ commissions, payouts, withdrawals, ledger });
  }

  /** Дамп всех пяти referral-таблиц (canary/идемпотентность). */
  async function referralDump(): Promise<string> {
    return JSON.stringify(await rows(
      `SELECT (SELECT jsonb_agg(to_jsonb(l)) FROM referral_leaders l) AS leaders,
              (SELECT jsonb_agg(to_jsonb(r)) FROM referral_referees r) AS referees,
              (SELECT jsonb_agg(to_jsonb(c)) FROM referral_commissions c) AS commissions,
              (SELECT jsonb_agg(to_jsonb(p)) FROM referral_token_payouts p) AS payouts,
              (SELECT jsonb_agg(to_jsonb(w)) FROM referral_withdrawals w) AS withdrawals`));
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 2, options: `-c search_path=${SCHEMA}` });

    // Базовые таблицы — faithful-копия 001_core_schema.sql (ДО расширения
    // 001_user_id_to_text.sql: телефонные колонки varchar(20), настоящие
    // CHECK/UNIQUE).
    await pool.query(`
      CREATE TABLE user_id (
        internal_id text PRIMARY KEY,
        state text,
        deleted_at timestamptz,
        deletion_id uuid,
        welcome_bonus_at timestamptz
      );
      CREATE TABLE ai_profiles_consolidated (
        user_id text PRIMARY KEY,
        tokens bigint DEFAULT 0,
        signup_source text,
        isadmin boolean DEFAULT false
      );
      CREATE TYPE transaction_type_enum AS ENUM
        ('purchase','consumed','bonus','refund','adjustment','coupon');
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
    `);
    // Инлайновые таблицы — копия ИСТОРИЧЕСКОЙ формы CREATE из
    // ReferralService.onModuleInit (user_phone varchar(20), как на проду до
    // Task 17C): guarded-расширение до varchar(64) должно пройти по ним.
    await pool.query(`
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

    // Реальный путь расширения: onModuleInit применяет инлайн-DDL и migrations/
    // (001 расширяет три колонки до text; 002 на пустых таблицах вставляет 0 строк).
    await makeService().onModuleInit();

    adapter = new ReferralAccountDeletionAdapter(new AccountDeletionRegistry());
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE referral_commissions, referral_leaders, referral_referees,
                referral_token_payouts, referral_withdrawals,
                user_id, ai_profiles_consolidated, token_transactions`,
    );
    await seedUser(USER, 'deleted', deletionId);
    await seedUser(OTHER, 'active');
  });

  it('onModuleInit расширяет телефонные колонки до размера alias (varchar(20) → varchar(64)/text)', async () => {
    const cols = await rows(
      `SELECT table_name, data_type, character_maximum_length
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND ((table_name='referral_token_payouts' AND column_name='user_phone')
            OR (table_name='referral_withdrawals' AND column_name='user_phone')
            OR (table_name='referral_leaders' AND column_name='user_phone')
            OR (table_name='referral_referees' AND column_name='referee_phone')
            OR (table_name='referral_commissions' AND column_name='referee_phone'))`);
    const byTable = new Map(cols.map((c) => [c.table_name, c]));
    // Две инлайновые колонки — varchar(64) (guarded ALTER в onModuleInit).
    expect(byTable.get('referral_token_payouts')).toMatchObject({
      data_type: 'character varying', character_maximum_length: 64,
    });
    expect(byTable.get('referral_withdrawals')).toMatchObject({
      data_type: 'character varying', character_maximum_length: 64,
    });
    // Три колонки базовой схемы — уже text (migrations/001_user_id_to_text.sql).
    for (const t of ['referral_leaders', 'referral_referees', 'referral_commissions']) {
      expect(byTable.get(t)).toMatchObject({ data_type: 'text' });
    }
    // Alias (44 символа) физически помещается в каждую колонку.
    expect(ALIAS).toHaveLength(44);
  });

  it('referral.stop: деактивирует своего лидера, чужой не тронут', async () => {
    const mine = await seedLeader(USER, 'slug-del');
    const theirs = await seedLeader(OTHER, 'slug-other');
    const ctx = makeCtx();

    await adapter.execute(jobRow('referral.stop'), ctx);

    expect(await rows(`SELECT is_active FROM referral_leaders WHERE id=$1`, [mine]))
      .toEqual([{ is_active: false }]);
    expect(await rows(`SELECT is_active FROM referral_leaders WHERE id=$1`, [theirs]))
      .toEqual([{ is_active: true }]);
    expect(ctx.assertCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'referral.stop' }),
    );
  });

  it('pending withdrawal сохраняет обязательство и retry: external_unknown, ноль изменений', async () => {
    const leaderId = await seedLeader(USER, 'slug-del');
    const commId = await seedCommission(leaderId, OTHER, 1, 600, true, 'pay-fake-0001');
    await seedWithdrawal(leaderId, USER, 500, 'pending', LONE_CANARY, [commId]);
    const before = await financialSnapshot();
    const beforeDump = await referralDump();

    const err = await adapter.execute(jobRow('referral.purge'), makeCtx()).catch((e) => e);

    expect(err).toBeInstanceOf(DeletionRetryError);
    expect(err).toMatchObject({ kind: 'external_unknown' });
    // Обязательство и весь остальной срез — без единого изменения.
    expect(await financialSnapshot()).toBe(before);
    expect(await referralDump()).toBe(beforeDump);
    const w = await rows(`SELECT user_phone, requisites, status FROM referral_withdrawals`);
    expect(w[0]).toMatchObject({ user_phone: USER, requisites: LONE_CANARY, status: 'pending' });
    const l = await rows(`SELECT user_phone, is_active FROM referral_leaders WHERE id=$1`, [leaderId]);
    expect(l[0]).toMatchObject({ user_phone: USER, is_active: true });
  });

  it('pending находится и при разъехавшейся денормализованной копии user_phone (связь через leader_id)', async () => {
    const leaderId = await seedLeader(USER, 'slug-del');
    await seedWithdrawal(leaderId, 'u-stale-copy', 500, 'pending', LONE_CANARY, []);

    await expect(
      adapter.execute(jobRow('referral.purge'), makeCtx()),
    ).rejects.toMatchObject({ kind: 'external_unknown' });

    expect(await rows(`SELECT user_phone FROM referral_leaders WHERE id=$1`, [leaderId]))
      .toEqual([{ user_phone: USER }]);
  });

  it('settled (paid+rejected): aliases вместо phone в пяти колонках, суммы/payment IDs/ledger неизменны', async () => {
    const leaderId = await seedLeader(USER, 'slug-del', 'Имя Лидера');
    const otherLeaderId = await seedLeader(OTHER, 'slug-other', 'Другой Лидер');
    // USER когда-то был рефералом OTHER (его строки алиасятся);
    // OTHER — реферал USER (чужие данные purge не трогает).
    await seedReferee(USER, otherLeaderId);
    await seedReferee(OTHER, leaderId);
    const c1 = await seedCommission(otherLeaderId, USER, 1, 1990, false, 'pay-fake-0001');
    const c2 = await seedCommission(leaderId, OTHER, 1, 990, true, 'pay-fake-0002');
    await seedPayout(leaderId, USER, 120, 90000, 750, [c2]);
    await seedWithdrawal(leaderId, USER, 500, 'paid', LONE_CANARY, [c1]);
    await seedWithdrawal(leaderId, USER, 300, 'rejected', SECOND_CANARY, []);
    // Строка ledger с user_id удалённого: token_transactions не трогаем вообще.
    await pool.query(
      `INSERT INTO token_transactions (user_id, transaction_type, amount, balance_after, description)
       VALUES ($1,'bonus',123,456,'ledger row stays')`,
      [USER],
    );
    const before = await financialSnapshot();

    await adapter.execute(jobRow('referral.stop'), makeCtx());
    await adapter.execute(jobRow('referral.purge'), makeCtx());

    // Финансовый срез (payment_id, commission_ids, суммы, paid_out, статусы,
    // processed_at/by, token_transactions) — байт-в-байт.
    expect(await financialSnapshot()).toBe(before);

    const leaders = await rows(`SELECT user_phone, name, slug, is_active FROM referral_leaders ORDER BY slug`);
    const mine = leaders.find((l) => l.slug === `deleted-${deletionId}`);
    expect(mine).toBeDefined();
    expect(mine).toMatchObject({ user_phone: ALIAS, name: '', is_active: false });
    expect(leaders.find((l) => l.slug === 'slug-other')).toMatchObject({
      user_phone: OTHER, name: 'Другой Лидер', is_active: true,
    });

    const referees = await rows(`SELECT referee_phone, leader_id FROM referral_referees`);
    expect(referees.map((r) => r.referee_phone).sort()).toEqual([ALIAS, OTHER].sort());
    expect(referees.find((r) => r.referee_phone === ALIAS).leader_id).toBe(otherLeaderId);

    const comms = await rows(`SELECT id, referee_phone FROM referral_commissions ORDER BY id`);
    expect(comms.find((c) => c.id === c1).referee_phone).toBe(ALIAS);
    expect(comms.find((c) => c.id === c2).referee_phone).toBe(OTHER);

    expect(await rows(`SELECT user_phone FROM referral_token_payouts`))
      .toEqual([{ user_phone: ALIAS }]);

    const ws = await rows(`SELECT user_phone, requisites, status FROM referral_withdrawals ORDER BY status`);
    expect(ws).toHaveLength(2);
    expect(ws.map((w) => w.status)).toEqual(['paid', 'rejected']);
    for (const w of ws) {
      expect(w.user_phone).toBe(ALIAS);
      expect(w.requisites).toBe('');
    }

    // Canary: телефон и реквизиты исчезли из всех пяти referral-таблиц.
    const dump = await referralDump();
    expect(dump).not.toContain(USER);
    expect(dump).not.toContain(LONE_CANARY);
    expect(dump).not.toContain(SECOND_CANARY);
    expect(dump).toContain(ALIAS);
  });

  it('после purge повторная регистрация телефона не упирается в старый UNIQUE referee', async () => {
    const otherLeaderId = await seedLeader(OTHER, 'slug-other');
    await seedReferee(USER, otherLeaderId);

    await adapter.execute(jobRow('referral.stop'), makeCtx());
    await adapter.execute(jobRow('referral.purge'), makeCtx());

    // «Новый» аккаунт на тот же телефон (в жизни реактивацию ведёт identity).
    await pool.query(
      `UPDATE user_id SET state='active', deletion_id=NULL, welcome_bonus_at=now()
        WHERE internal_id=$1`,
      [USER],
    );
    await seedLeader(THIRD, 'slug-third', 'Третий Лидер');

    const res = await makeService().register(USER, 'slug-third');

    expect(res).toMatchObject({ success: true, bonus_tokens: 0 });
    const referees = await rows(`SELECT referee_phone FROM referral_referees ORDER BY referee_phone`);
    expect(referees.map((r) => r.referee_phone)).toEqual([ALIAS, USER].sort());
  });

  it('register: удалённый аккаунт не привязывается (state-гейт нового аккаунта)', async () => {
    await seedLeader(OTHER, 'slug-other');

    const res = await makeService().register(USER, 'slug-other');

    expect(res).toMatchObject({ success: false, error: 'Referral link works only for new accounts' });
    expect(await rows(`SELECT count(*)::int AS n FROM referral_referees`)).toEqual([{ n: 0 }]);
  });

  describe('withdraw/payout: деактивированный лидер отсечён strict-предикатом', () => {
    it('requestWithdrawal — BadRequest, заявка не создаётся', async () => {
      const leaderId = await seedLeader(USER, 'slug-del');
      await seedCommission(leaderId, OTHER, 1, 600, false, 'pay-fake-0001');
      await adapter.execute(jobRow('referral.stop'), makeCtx());

      await expect(
        makeService().requestWithdrawal(USER, 'card', 'РЕКВИЗИТЫ-ФЕЙК-1234'),
      ).rejects.toThrow('Реферальный аккаунт не найден');
      expect(await rows(`SELECT count(*)::int AS n FROM referral_withdrawals`)).toEqual([{ n: 0 }]);
      // Комиссии не зарезервированы.
      expect(await rows(`SELECT paid_out FROM referral_commissions`)).toEqual([{ paid_out: false }]);
    });

    it('payoutTokens — BadRequest, начисления нет', async () => {
      const leaderId = await seedLeader(USER, 'slug-del');
      await seedCommission(leaderId, OTHER, 1, 600, false, 'pay-fake-0001');
      await adapter.execute(jobRow('referral.stop'), makeCtx());

      await expect(makeService().payoutTokens(USER)).rejects.toBeInstanceOf(BadRequestException);
      expect(await rows(`SELECT count(*)::int AS n FROM referral_token_payouts`)).toEqual([{ n: 0 }]);
      expect(await rows(`SELECT paid_out FROM referral_commissions`)).toEqual([{ paid_out: false }]);
    });
  });

  describe('notifyPayoutIfReady: SMS только активному лидеру', () => {
    let origLogin: string | undefined;
    let origKey: string | undefined;

    beforeEach(() => {
      origLogin = process.env.SMSAERO_LOGIN;
      origKey = process.env.SMSAERO_API_KEY;
      process.env.SMSAERO_LOGIN = 'fake-login';
      process.env.SMSAERO_API_KEY = 'fake-key';
      (axios.get as jest.Mock).mockReset().mockResolvedValue({ status: 200, data: {} });
    });

    afterEach(() => {
      if (origLogin === undefined) delete process.env.SMSAERO_LOGIN;
      else process.env.SMSAERO_LOGIN = origLogin;
      if (origKey === undefined) delete process.env.SMSAERO_API_KEY;
      else process.env.SMSAERO_API_KEY = origKey;
    });

    it('деактивированный лидер — SMS нет, payout_notified не взведён', async () => {
      const leaderId = await seedLeader(NUM_LEADER, 'slug-num');
      // commission_rub=600 — ВЫШЕ порога WITHDRAW_MIN_RUB (500): тест
      // содержателен именно про active-гейт, а не про порог суммы.
      await seedCommission(leaderId, OTHER, 1, 6000, false, 'pay-fake-0001');
      await pool.query(`UPDATE referral_leaders SET is_active=false WHERE id=$1`, [leaderId]);

      await (makeService() as any).notifyPayoutIfReady(leaderId);

      expect(axios.get).not.toHaveBeenCalled();
      expect(await rows(`SELECT payout_notified FROM referral_leaders WHERE id=$1`, [leaderId]))
        .toEqual([{ payout_notified: false }]);
    });

    it('активный лидер — SMS уходит (гейт не блокирует живых)', async () => {
      const leaderId = await seedLeader(NUM_LEADER, 'slug-num');
      // commission_rub=600 — выше порога WITHDRAW_MIN_RUB (500), чтобы дойти
      // до sendSms; гейт обязан пропустить активного лидера.
      await seedCommission(leaderId, OTHER, 1, 6000, false, 'pay-fake-0001');

      await (makeService() as any).notifyPayoutIfReady(leaderId);

      expect(axios.get).toHaveBeenCalledTimes(1);
      expect((axios.get as jest.Mock).mock.calls[0][1].params.number).toBe(NUM_LEADER);
      expect(await rows(`SELECT payout_notified FROM referral_leaders WHERE id=$1`, [leaderId]))
        .toEqual([{ payout_notified: true }]);
    });
  });

  it('идемпотентность: повторный purge — снимок совпадает, тихий успех', async () => {
    const leaderId = await seedLeader(USER, 'slug-del');
    await seedReferee(USER, leaderId);
    const c = await seedCommission(leaderId, USER, 1, 600, true, 'pay-fake-0001');
    await seedPayout(leaderId, USER, 500, 375000, 750, [c]);
    await seedWithdrawal(leaderId, USER, 500, 'paid', LONE_CANARY, [c]);

    await adapter.execute(jobRow('referral.stop'), makeCtx());
    await adapter.execute(jobRow('referral.purge'), makeCtx());
    const first = await referralDump();

    await expect(adapter.execute(jobRow('referral.purge'), makeCtx())).resolves.toBeUndefined();

    const second = await referralDump();
    expect(second).toBe(first);
    expect(second).toContain(ALIAS);
    expect(second).not.toContain(`"${USER}"`);
  });

  it('generation mismatch — тихий успех, строки не тронуты', async () => {
    // Другое поколение удаления (например, реактивация + новое удаление).
    await pool.query(`UPDATE user_id SET deletion_id=$1 WHERE internal_id=$2`, [randomUUID(), USER]);
    const leaderId = await seedLeader(USER, 'slug-del');
    await seedReferee(USER, leaderId);

    await expect(adapter.execute(jobRow('referral.stop'), makeCtx())).resolves.toBeUndefined();
    await expect(adapter.execute(jobRow('referral.purge'), makeCtx())).resolves.toBeUndefined();

    expect(await rows(`SELECT user_phone, is_active, slug FROM referral_leaders WHERE id=$1`, [leaderId]))
      .toEqual([{ user_phone: USER, is_active: true, slug: 'slug-del' }]);
    expect(await rows(`SELECT referee_phone FROM referral_referees`))
      .toEqual([{ referee_phone: USER }]);
  });

  it('reactivation между discovery и execute — DeletionCancelledError, записи нет', async () => {
    const leaderId = await seedLeader(USER, 'slug-del');
    await seedWithdrawal(leaderId, USER, 500, 'paid', LONE_CANARY, []);
    const ctx = makeCtx();
    ctx.assertCurrent.mockRejectedValue(new DeletionCancelledError());

    await expect(adapter.execute(jobRow('referral.purge'), ctx))
      .rejects.toBeInstanceOf(DeletionCancelledError);

    expect(await rows(`SELECT user_phone, requisites FROM referral_withdrawals`))
      .toEqual([{ user_phone: USER, requisites: LONE_CANARY }]);
    expect(await rows(`SELECT user_phone, is_active FROM referral_leaders WHERE id=$1`, [leaderId]))
      .toEqual([{ user_phone: USER, is_active: true }]);
  });
});
