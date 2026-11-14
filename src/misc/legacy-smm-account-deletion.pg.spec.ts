import { MODULE_METADATA } from '@nestjs/common/constants';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import { DELETION_DISCOVERERS } from '../account-deletion/account-deletion.catalog';
import {
  DeletionCancelledError,
  DeletionRetryError,
  assertSafeSkip,
  safeDeletionJobSnapshot,
} from '../account-deletion/account-deletion.safe';
import type {
  DeletionAccount,
  DeletionExecution,
  DeletionJobRow,
  DeletionSkip,
} from '../account-deletion/account-deletion.types';
import { MiscModule } from './misc.module';
import {
  LegacySmmAccountDeletionAdapter,
  discoverLegacySmmDeletion,
} from './legacy-smm-account-deletion.adapter';

/**
 * Task 17E — legacy SMM: stop отзывает credentials и гасит активные цепочки,
 * purge обезличивает контент, billing evidence (строки ledger/premium и ВСЕ
 * суммы) сохраняется через deletion-scoped alias, общие таблицы
 * (smm_music_track, smm_pricing) и official-кампании не выбираются никогда.
 *
 * Fix-раунд (design-спек 2026-11-11, строка 44: «секреты соединений
 * удаляются по действующим правилам» — БЕЗ условия наличия кампаний):
 * job'ы двух форм — per-campaign (resourceKey=campaignId, campaign-scoped
 * статусы/контент) и user-scoped (статический resourceKey 'legacy-smm',
 * payload {}: social account revoke + oauth DELETE в stop, alias ledger/
 * premium в purge). User-scoped пара создаётся discovery при наличии
 * user-scoped строк, даже когда собственных кампаний нет вовсе.
 *
 * PG-часть обязательна: у smm_* нет FOREIGN KEYS (001_core_schema.sql),
 * цепочка владения campaign → smm_scenario(campaign_id) → smm_video(scenario_id)
 * → smm_publication(video_id) собирается руками через joins, и честность
 * billing-среза (суммы, video-ссылки, op/reason) проверяется на настоящей БД.
 * Alias 'deleted:<deletionId>' — 44 символа; user_id-колонки ledger и
 * premium_generation — text, помещается без расширения (проверяет спек).
 *
 * DDL ниже — дословная копия 001_core_schema.sql (CREATE TABLE + настоящие
 * PK/UNIQUE/CHECK), без schema-квалификатора (search_path теста).
 */

const USER = 'u-legacy-smm-del';
const OTHER = 'u-legacy-smm-other';
const deletionId = '6c2f7b3d-4e5a-4f6b-8a9c-1d2e3f4a5b6c';
const ALIAS = `deleted:${deletionId}`;
const DELETED_AT = new Date('2026-11-01T00:00:00.000Z');
const account: DeletionAccount = { userId: USER, deletionId, deletedAt: DELETED_AT };

const TOPIC_CANARY = 'ТЕМА-КАНАРЕЙКА-ЛИЧНАЯ';
const OFFICIAL_TOPIC = 'platform topic';
const DIALOG_CANARY = 'ДИАЛОГ-КАНАРЕЙКА';
const SCENES_CANARY = 'СЦЕНЫ-КАНАРЕЙКА';
const BROLL_CANARY = 'БРОЛ-КАНАРЕЙКА';
const CAPTION_CANARY = 'ПОДПИСЬ-КАНАРЕЙКА';
const CRED_CANARY = 'КРЕДЕНШЛ-КАНАРЕЙКА-СЕКРЕТ';
const CTA_HANDLE_CANARY = 'КАНАРЕЙКА-handle';
const CTA_SLOGAN_CANARY = 'КАНАРЕЙКА-slogan';
const PUBLISH_CAPTION_CANARY = 'КАНАРЕЙКА-publish-caption';
const LOGO_CANARY = 'https://fake.example/logo-canary.png';
const BG_CANARY = 'https://fake.example/bg-canary.png';
const MP4_CANARY = 'https://fake.example/video-canary.mp4';
const EXTERNAL_URL_CANARY = 'https://fake.example/wall-canary';
const EXTERNAL_ID_CANARY = 'ext-post-canary-12345';
const RENDER_CANARY = 'RENDER-КАНАРЕЙКА';
const ERROR_CANARY = 'ERROR-КАНАРЕЙКА';
const EVENT_CANARY = 'EVENT-КАНАРЕЙКА';
const CONVERSATION_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

// ==================== Discovery / wiring (без PG) ====================

const CAMPAIGN_A = '00000000-0000-4000-8000-0000000000c1';
const CAMPAIGN_B = '00000000-0000-4000-8000-0000000000c2';

/** Статический resourceKey user-scoped пары (образец tasks/support/peer). */
const USER_KEY = 'legacy-smm';

class FakeSmmDb {
  readonly queries: Array<{ sql: string; params: any[] }> = [];
  constructor(private opts: {
    genOk: boolean;
    campaignIds: string[];
    externalSeen: boolean;
    userScopedSeen: boolean;
  }) {}
  async query(sql: string, params: any[] = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    this.queries.push({ sql: s, params });
    if (s.startsWith('SELECT 1 FROM user_id')) {
      return this.opts.genOk ? { rows: [{ n: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('SELECT c.id FROM smm_campaign')) {
      const last = (params[1] as string | null) ?? null;
      const limit = Number(params[3]);
      const page = [...this.opts.campaignIds]
        .sort()
        .filter((id) => !last || id > last)
        .slice(0, limit);
      return { rows: page.map((id) => ({ id })), rowCount: page.length };
    }
    if (s.startsWith('SELECT 1 FROM smm_publication')) {
      return this.opts.externalSeen
        ? { rows: [{ n: 1 }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('SELECT 1 WHERE EXISTS')) {
      return this.opts.userScopedSeen
        ? { rows: [{ n: 1 }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    throw new Error(`unexpected query: ${s}`);
  }
}

function jobRow(
  resourceType: 'legacy-smm.stop' | 'legacy-smm.purge',
  campaignId: string,
  overrides: Partial<DeletionJobRow> = {},
): DeletionJobRow {
  return {
    id: `job-${resourceType}-${campaignId}`,
    deletionId,
    userId: USER,
    resourceType,
    resourceKey: campaignId,
    phase: resourceType === 'legacy-smm.stop' ? 'immediate' : 'purge',
    payload: { campaignId },
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date('2026-12-14T00:00:00Z'),
    leaseUntil: new Date('2026-12-14T01:00:00Z'),
    lastErrorKind: null,
    ...overrides,
  };
}

function userScopedJobRow(
  resourceType: 'legacy-smm.stop' | 'legacy-smm.purge',
  overrides: Partial<DeletionJobRow> = {},
): DeletionJobRow {
  return jobRow(resourceType, USER_KEY, {
    id: `job-${resourceType}-user`,
    resourceKey: USER_KEY,
    payload: {},
    ...overrides,
  });
}

describe('discoverLegacySmmDeletion — stop+purge на каждую собственную кампанию (Task 17E)', () => {
  it('два jobа на кампанию (stop immediate, purge purge), payload только {campaignId}; sanitizer плана проходит', async () => {
    const db = new FakeSmmDb({ genOk: true, campaignIds: [CAMPAIGN_A, CAMPAIGN_B], externalSeen: false, userScopedSeen: false });

    const plan = await discoverLegacySmmDeletion({ db, account, origin: 'explicit' });

    expect(plan.jobs).toEqual([
      { resourceType: 'legacy-smm.stop', resourceKey: CAMPAIGN_A, phase: 'immediate', payload: { campaignId: CAMPAIGN_A } },
      { resourceType: 'legacy-smm.purge', resourceKey: CAMPAIGN_A, phase: 'purge', payload: { campaignId: CAMPAIGN_A } },
      { resourceType: 'legacy-smm.stop', resourceKey: CAMPAIGN_B, phase: 'immediate', payload: { campaignId: CAMPAIGN_B } },
      { resourceType: 'legacy-smm.purge', resourceKey: CAMPAIGN_B, phase: 'purge', payload: { campaignId: CAMPAIGN_B } },
    ]);
    expect(plan.skips).toEqual([]);
    const json = JSON.stringify(plan.jobs);
    expect(json).not.toContain(USER);
    expect(json).not.toContain(TOPIC_CANARY);
    expect(json).not.toContain(CRED_CANARY);
    for (const job of plan.jobs) {
      expect(() => safeDeletionJobSnapshot(job, USER)).not.toThrow();
    }
    // Discovery только читает: generation gate + кампании + наличие внешних
    // постов — никаких мутаций и никаких внешних вызовов.
    expect(db.queries.every((q) => q.sql.startsWith('SELECT'))).toBe(true);
  });

  it('keyset-пагинация: pageSize=1 обходит все кампании', async () => {
    const db = new FakeSmmDb({ genOk: true, campaignIds: [CAMPAIGN_A, CAMPAIGN_B], externalSeen: false, userScopedSeen: false });

    const plan = await discoverLegacySmmDeletion({
      db, account, origin: 'explicit', pageSize: 1,
    } as any);

    expect(plan.jobs.map((j) => j.resourceKey)).toEqual([
      CAMPAIGN_A, CAMPAIGN_A, CAMPAIGN_B, CAMPAIGN_B,
    ]);
    // 1 gen + 3 страницы (A, B, пустая) + 1 external-exists + 1 user-scoped-exists.
    expect(db.queries.filter((q) => q.sql.startsWith('SELECT c.id FROM smm_campaign'))).toHaveLength(3);
  });

  it('reactivation (поколение не совпало) — план пустой, таблицы не читаются', async () => {
    const db = new FakeSmmDb({ genOk: false, campaignIds: [CAMPAIGN_A], externalSeen: true, userScopedSeen: true });

    const plan = await discoverLegacySmmDeletion({ db, account, origin: 'explicit' });

    expect(plan).toEqual({ jobs: [], skips: [] });
    expect(db.queries).toHaveLength(1);
  });

  it('внешний пост без deletion adapter — один unsupported_external skip, а не выдуманный API/SSH вызов', async () => {
    const db = new FakeSmmDb({ genOk: true, campaignIds: [CAMPAIGN_A], externalSeen: true, userScopedSeen: false });

    const plan = await discoverLegacySmmDeletion({ db, account, origin: 'explicit' });

    expect(plan.skips).toEqual([
      { resourceType: 'legacy-smm.purge', reason: 'unsupported_external' },
    ]);
    for (const skip of plan.skips) {
      expect(() => assertSafeSkip(skip)).not.toThrow();
    }
    // Никаких не-SQL запросов (внешние вызовы к соцсетям запрещены планом).
    expect(db.queries.every((q) => q.sql.startsWith('SELECT'))).toBe(true);
  });

  it('user-scoped строки без кампаний — пара с статическим ключом legacy-smm и пустым payload', async () => {
    const db = new FakeSmmDb({ genOk: true, campaignIds: [], externalSeen: false, userScopedSeen: true });

    const plan = await discoverLegacySmmDeletion({ db, account, origin: 'explicit' });

    expect(plan.jobs).toEqual([
      { resourceType: 'legacy-smm.stop', resourceKey: USER_KEY, phase: 'immediate', payload: {} },
      { resourceType: 'legacy-smm.purge', resourceKey: USER_KEY, phase: 'purge', payload: {} },
    ]);
    expect(plan.skips).toEqual([]);
    const json = JSON.stringify(plan.jobs);
    expect(json).not.toContain(USER);
    expect(json).not.toContain(CRED_CANARY);
    for (const job of plan.jobs) {
      expect(() => safeDeletionJobSnapshot(job, USER)).not.toThrow();
    }
    expect(db.queries.every((q) => q.sql.startsWith('SELECT'))).toBe(true);
  });

  it('кампании + user-scoped строки — обе пары jobов', async () => {
    const db = new FakeSmmDb({ genOk: true, campaignIds: [CAMPAIGN_A], externalSeen: false, userScopedSeen: true });

    const plan = await discoverLegacySmmDeletion({ db, account, origin: 'explicit' });

    expect(plan.jobs).toEqual([
      { resourceType: 'legacy-smm.stop', resourceKey: CAMPAIGN_A, phase: 'immediate', payload: { campaignId: CAMPAIGN_A } },
      { resourceType: 'legacy-smm.purge', resourceKey: CAMPAIGN_A, phase: 'purge', payload: { campaignId: CAMPAIGN_A } },
      { resourceType: 'legacy-smm.stop', resourceKey: USER_KEY, phase: 'immediate', payload: {} },
      { resourceType: 'legacy-smm.purge', resourceKey: USER_KEY, phase: 'purge', payload: {} },
    ]);
    for (const job of plan.jobs) {
      expect(() => safeDeletionJobSnapshot(job, USER)).not.toThrow();
    }
  });

  it('нет ни кампаний, ни user-scoped строк — план пустой', async () => {
    const db = new FakeSmmDb({ genOk: true, campaignIds: [], externalSeen: false, userScopedSeen: false });

    const plan = await discoverLegacySmmDeletion({ db, account, origin: 'explicit' });

    expect(plan).toEqual({ jobs: [], skips: [] });
  });
});

describe('wiring legacy-smm.stop/legacy-smm.purge (Task 17E)', () => {
  it('adapter регистрирует legacy-smm.stop и legacy-smm.purge, MiscModule его провайдит', () => {
    const registry = { register: jest.fn() } as any;
    const adapter = new LegacySmmAccountDeletionAdapter({} as any, registry);
    expect(adapter.resourceTypes).toEqual(['legacy-smm.stop', 'legacy-smm.purge']);
    adapter.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(adapter);

    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, MiscModule) ?? []).flat(Infinity);
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, MiscModule) ?? [];
    expect(imports.filter((item: unknown) => item === AccountDeletionModule)).toHaveLength(1);
    expect(providers.filter((item: unknown) => item === LegacySmmAccountDeletionAdapter)).toHaveLength(1);
  });

  it('catalog содержит discoverLegacySmmDeletion ровно один раз', () => {
    expect(
      DELETION_DISCOVERERS.filter((item) => item === discoverLegacySmmDeletion),
    ).toHaveLength(1);
  });

  it('чужой resourceType — отказ до любой записи', async () => {
    const db = new FakeSmmDb({ genOk: true, campaignIds: [], externalSeen: false, userScopedSeen: false });
    const adapter = new LegacySmmAccountDeletionAdapter({} as any, new AccountDeletionRegistry());
    const ctx: DeletionExecution = { db, assertCurrent: jest.fn(async () => undefined) };

    await expect(
      adapter.execute(jobRow('legacy-smm.purge', CAMPAIGN_A, { resourceType: 'avatar.purge' as any }), ctx),
    ).rejects.toThrow('unsupported_deletion_resource');
    expect(ctx.assertCurrent).not.toHaveBeenCalled();
    expect(db.queries).toHaveLength(0);
  });

  it('payload без валидного campaignId — DeletionRetryError(db) до любой записи', async () => {
    const db = new FakeSmmDb({ genOk: true, campaignIds: [], externalSeen: false, userScopedSeen: false });
    const adapter = new LegacySmmAccountDeletionAdapter({} as any, new AccountDeletionRegistry());
    const ctx: DeletionExecution = { db, assertCurrent: jest.fn(async () => undefined) };

    await expect(
      adapter.execute(jobRow('legacy-smm.purge', CAMPAIGN_A, { payload: { campaignId: 'not-a-uuid' } }), ctx),
    ).rejects.toBeInstanceOf(DeletionRetryError);
    await expect(
      adapter.execute(jobRow('legacy-smm.stop', CAMPAIGN_A, { payload: {} }), ctx),
    ).rejects.toMatchObject({ kind: 'db' });
    expect(ctx.assertCurrent).not.toHaveBeenCalled();
    expect(db.queries).toHaveLength(0);
  });

  it('user-scoped job с непустым payload — DeletionRetryError(db) до любой записи', async () => {
    const db = new FakeSmmDb({ genOk: true, campaignIds: [], externalSeen: false, userScopedSeen: false });
    const adapter = new LegacySmmAccountDeletionAdapter({} as any, new AccountDeletionRegistry());
    const ctx: DeletionExecution = { db, assertCurrent: jest.fn(async () => undefined) };

    await expect(
      adapter.execute(userScopedJobRow('legacy-smm.purge', { payload: { campaignId: CAMPAIGN_A } }), ctx),
    ).rejects.toMatchObject({ kind: 'db' });
    expect(ctx.assertCurrent).not.toHaveBeenCalled();
    expect(db.queries).toHaveLength(0);
  });
});

// ==================== PG-часть ====================

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `legacy_smm_acct_del_spec_${process.pid}`;

maybe('legacy SMM account deletion against PostgreSQL (Task 17E)', () => {
  jest.setTimeout(60_000);

  let admin: Pool;
  let pool: Pool;
  let adapter: LegacySmmAccountDeletionAdapter;

  function makeCtx(): DeletionExecution & { assertCurrent: jest.Mock } {
    return {
      db: { query: (sql: string, params?: unknown[]) => pool.query(sql, params as any[]) },
      assertCurrent: jest.fn(async () => undefined),
    };
  }

  function makePg() {
    return {
      query: (sql: string, params?: any[]) => pool.query(sql, params),
      getClient: () => pool.connect(),
    } as any;
  }

  function discoveryCtx() {
    return {
      db: { query: (sql: string, params?: unknown[]) => pool.query(sql, params as any[]) },
      account,
      origin: 'explicit' as const,
    };
  }

  /**
   * Полный прогон удаления: stop-фаза (user-scoped + кампании), затем
   * purge-фаза (кампании + user-scoped) — порядок sameResourceKey-пар.
   */
  async function runDeletion(campaignIds: string[] = []): Promise<void> {
    await adapter.execute(userScopedJobRow('legacy-smm.stop'), makeCtx());
    for (const id of campaignIds) {
      await adapter.execute(jobRow('legacy-smm.stop', id), makeCtx());
    }
    for (const id of campaignIds) {
      await adapter.execute(jobRow('legacy-smm.purge', id), makeCtx());
    }
    await adapter.execute(userScopedJobRow('legacy-smm.purge'), makeCtx());
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

  async function seedCampaign(
    userId: string,
    opts: { official?: boolean; topic?: string | null; status?: string; conversationId?: string | null } = {},
  ): Promise<string> {
    const r = await pool.query(
      `INSERT INTO smm_campaign (user_id, conversation_id, topic, source_mode, requested_count, status, is_linkeon_official)
       VALUES ($1,$2::uuid,$3,'topic',3,$4,$5) RETURNING id`,
      [userId, opts.conversationId ?? null, opts.topic ?? null,
        opts.status ?? 'approved', opts.official ?? false],
    );
    return r.rows[0].id;
  }

  async function seedScenario(
    campaignId: string,
    opts: { title?: string; dialog?: any; broll?: any; scenesJson?: any } = {},
  ): Promise<string> {
    const r = await pool.query(
      `INSERT INTO smm_scenario (campaign_id, title, assistant_role, dialog, mood, broll_prompts, scenes_json)
       VALUES ($1,$2,'narrator',$3::jsonb,'calm',$4::jsonb,$5::jsonb) RETURNING id`,
      [campaignId, opts.title ?? 'Сценарий',
        JSON.stringify(opts.dialog ?? [{ role: 'user', text: DIALOG_CANARY }]),
        JSON.stringify(opts.broll ?? [BROLL_CANARY]),
        opts.scenesJson === undefined ? null : JSON.stringify(opts.scenesJson)],
    );
    return r.rows[0].id;
  }

  async function seedVideo(
    scenarioId: string,
    opts: { status?: string; mp4?: string | null; renderState?: any; error?: string | null; tokensCharged?: number } = {},
  ): Promise<string> {
    const r = await pool.query(
      `INSERT INTO smm_video (scenario_id, status, render_job_id, render_state, mp4_url, duration_sec, size_bytes, error_message, tokens_charged)
       VALUES ($1,$2,'render-fake-1',$3::jsonb,$4,30,1024,$5,$6) RETURNING id`,
      [scenarioId, opts.status ?? 'rendering',
        JSON.stringify(opts.renderState ?? { step: RENDER_CANARY }),
        opts.mp4 === undefined ? MP4_CANARY : opts.mp4,
        opts.error === undefined ? ERROR_CANARY : opts.error,
        opts.tokensCharged ?? 4200],
    );
    return r.rows[0].id;
  }

  async function seedPublication(
    videoId: string,
    platform: string,
    opts: { status?: string; caption?: string | null; externalPostId?: string | null; externalUrl?: string | null; error?: string | null } = {},
  ): Promise<string> {
    const r = await pool.query(
      `INSERT INTO smm_publication (video_id, platform, scheduled_at, status, publish_job_id, external_url, external_post_id, caption, error_message)
       VALUES ($1,$2,now(),$3,'publish-fake-1',$4,$5,$6,$7) RETURNING id`,
      [videoId, platform, opts.status ?? 'scheduled',
        opts.externalUrl === undefined ? EXTERNAL_URL_CANARY : opts.externalUrl,
        opts.externalPostId === undefined ? null : opts.externalPostId,
        opts.caption === undefined ? CAPTION_CANARY : opts.caption,
        opts.error === undefined ? null : opts.error],
    );
    return r.rows[0].id;
  }

  async function seedCreatorCampaign(campaignId: string): Promise<void> {
    await pool.query(
      `INSERT INTO smm_creator_campaign (campaign_id, cta_handle, cta_label, voice_gender, genre, logo_url, cta_slogan, publish_caption, bg_color, bg_image_url)
       VALUES ($1,$2,'Смотреть здесь','female','dialog',$3,$4,$5,'#123456',$6)`,
      [campaignId, CTA_HANDLE_CANARY, LOGO_CANARY, CTA_SLOGAN_CANARY, PUBLISH_CAPTION_CANARY, BG_CANARY],
    );
  }

  async function seedSocialAccount(userId: string, opts: { platform?: string; status?: string; credentials?: any } = {}): Promise<string> {
    const r = await pool.query(
      `INSERT INTO smm_social_account (user_id, platform, display_name, credentials, status)
       VALUES ($1,$2,'fake-display-name',$3::jsonb,$4) RETURNING id`,
      [userId, opts.platform ?? 'vk',
        JSON.stringify(opts.credentials ?? { access_token: CRED_CANARY }),
        opts.status ?? 'active'],
    );
    return r.rows[0].id;
  }

  async function seedOauthState(userId: string, platform = 'vk'): Promise<void> {
    await pool.query(
      `INSERT INTO smm_oauth_state (state, user_id, platform, redirect_url)
       VALUES ($1,$2,$3,'https://fake.example/cb')`,
      [`st-${userId}-${platform}`, userId, platform],
    );
  }

  async function seedLedger(
    userId: string,
    opts: { videoId?: string | null; amount: number; op: 'charge' | 'refund'; reason?: string },
  ): Promise<string> {
    const r = await pool.query(
      `INSERT INTO smm_billing_ledger (user_id, video_id, amount, op, reason)
       VALUES ($1,$2::uuid,$3,$4,$5) RETURNING id`,
      [userId, opts.videoId ?? null, opts.amount, opts.op, opts.reason ?? 'video_generation'],
    );
    return r.rows[0].id;
  }

  async function seedPremium(
    userId: string,
    opts: { videoId?: string | null; tokensCharged?: number; tokensRefunded?: number; internalCostCents?: number | null; status?: string } = {},
  ): Promise<string> {
    const r = await pool.query(
      `INSERT INTO smm_premium_generation (video_id, user_id, genre, scene_count, tokens_charged, tokens_refunded, status, internal_cost_cents, completed_at)
       VALUES ($1::uuid,$2,'cinematic',5,$3,$4,$5,$6,now()) RETURNING id`,
      [opts.videoId ?? null, userId, opts.tokensCharged ?? 5000,
        opts.tokensRefunded ?? 100, opts.status ?? 'completed',
        opts.internalCostCents === undefined ? 77 : opts.internalCostCents],
    );
    return r.rows[0].id;
  }

  async function seedEventLog(opts: { videoId?: string | null; publicationId?: string | null; eventType?: string }): Promise<string> {
    const r = await pool.query(
      `INSERT INTO smm_event_log (event_type, video_id, publication_id, payload)
       VALUES ($1,$2::uuid,$3::uuid,$4::jsonb) RETURNING id`,
      [opts.eventType ?? 'render_step', opts.videoId ?? null, opts.publicationId ?? null,
        JSON.stringify({ note: EVENT_CANARY })],
    );
    return r.rows[0].id;
  }

  async function seedShared(): Promise<void> {
    await pool.query(
      `INSERT INTO smm_music_track (id, title, mood, duration_sec, storage_key, license)
       VALUES ('track-shared-1','Shared Track','calm',120,'music/shared-fake.mp3','cc0')`);
    await pool.query(
      `INSERT INTO smm_pricing (id, tokens_cost, display_name, description, active)
       VALUES ('economy',4500,'Economy','shared pricing row',true)`);
  }

  /**
   * Финансовый срез: всё, что purge ОБЯЗАН сохранить байт-в-байт — id,
   * video-ссылки, ВСЕ денежные колонки (amount, tokens_charged,
   * tokens_refunded, internal_cost_cents), op/reason/status, тайминги и
   * технические метрики видео. Исключён только user_id — единственная
   * PII-колонка, которая по плану меняется (alias).
   */
  async function billingSnapshot(): Promise<string> {
    const ledger = await rows(
      `SELECT id, video_id, amount, op, reason, created_at
         FROM smm_billing_ledger ORDER BY created_at, id`);
    const premium = await rows(
      `SELECT id, video_id, genre, scene_count, tokens_charged, tokens_refunded,
              status, internal_cost_cents, created_at, completed_at
         FROM smm_premium_generation ORDER BY created_at, id`);
    const videoTotals = await rows(
      `SELECT id, tokens_charged, duration_sec, size_bytes, render_job_id
         FROM smm_video ORDER BY created_at, id`);
    return JSON.stringify({ ledger, premium, videoTotals });
  }

  /** Дамп всех 12 smm-таблиц (canary/идемпотентность/чужие данные). */
  async function fullDump(): Promise<string> {
    const r = await rows(`
      SELECT json_build_object(
        'ledger', (SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM smm_billing_ledger ORDER BY created_at, id) x),
        'campaigns', (SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM smm_campaign ORDER BY created_at, id) x),
        'creator', (SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM smm_creator_campaign ORDER BY campaign_id) x),
        'events', (SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM smm_event_log ORDER BY created_at, id) x),
        'music', (SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM smm_music_track ORDER BY id) x),
        'oauth', (SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM smm_oauth_state ORDER BY state) x),
        'premium', (SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM smm_premium_generation ORDER BY created_at, id) x),
        'pricing', (SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM smm_pricing ORDER BY id) x),
        'publications', (SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM smm_publication ORDER BY created_at, id) x),
        'scenarios', (SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM smm_scenario ORDER BY created_at, id) x),
        'social', (SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM smm_social_account ORDER BY created_at, id) x),
        'videos', (SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM smm_video ORDER BY created_at, id) x)
      ) AS dump`);
    return JSON.stringify(r[0].dump);
  }

  /** Представление БД в терминах RED-теста плана. */
  async function readDb() {
    return {
      socialAccounts: await rows(
        `SELECT id, user_id, platform, display_name, credentials, status FROM smm_social_account ORDER BY created_at, id`),
      oauthStates: await rows(`SELECT state, user_id, platform FROM smm_oauth_state ORDER BY created_at, state`),
      campaigns: await rows(
        `SELECT id, user_id, topic, conversation_id, status, is_linkeon_official FROM smm_campaign ORDER BY created_at, id`),
      scenarios: await rows(
        `SELECT id, campaign_id, title, dialog, broll_prompts, scenes_json FROM smm_scenario ORDER BY created_at, id`),
      videos: await rows(
        `SELECT id, scenario_id, status, render_state, mp4_url, error_message, tokens_charged FROM smm_video ORDER BY created_at, id`),
      publications: await rows(
        `SELECT id, video_id, platform, status, caption, external_url, external_post_id, error_message FROM smm_publication ORDER BY created_at, id`),
      creatorCampaigns: await rows(`SELECT * FROM smm_creator_campaign ORDER BY campaign_id`),
      eventLogs: await rows(`SELECT id, event_type, video_id, publication_id FROM smm_event_log ORDER BY created_at, id`),
      musicTracks: await rows(`SELECT * FROM smm_music_track ORDER BY id`),
      pricing: await rows(`SELECT * FROM smm_pricing ORDER BY id`),
    };
  }

  /** Собственная цепочка USER: campaign → creator → scenario → video → publication + billing. */
  async function seedOwnWorld(opts: {
    campaignStatus?: string;
    videoStatus?: string;
    publicationStatus?: string;
    externalPostId?: string | null;
    scenesJson?: any;
  } = {}) {
    const campaignId = await seedCampaign(USER, {
      topic: TOPIC_CANARY, status: opts.campaignStatus ?? 'approved', conversationId: CONVERSATION_ID,
    });
    await seedCreatorCampaign(campaignId);
    const scenarioId = await seedScenario(campaignId, {
      title: 'Личный заголовок',
      scenesJson: opts.scenesJson === undefined ? { scenes: [SCENES_CANARY] } : opts.scenesJson,
    });
    const videoId = await seedVideo(scenarioId, { status: opts.videoStatus ?? 'rendering' });
    const publicationId = await seedPublication(videoId, 'vk', {
      status: opts.publicationStatus ?? 'scheduled',
      externalPostId: opts.externalPostId ?? null,
    });
    await seedLedger(USER, { videoId, amount: 1000, op: 'charge' });
    await seedLedger(USER, { videoId, amount: 200, op: 'refund' });
    await seedPremium(USER, { videoId });
    return { campaignId, scenarioId, videoId, publicationId };
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 4, options: `-c search_path=${SCHEMA}` });

    // Базовая таблица поколения — копия формы из referral PG-spec.
    await pool.query(`
      CREATE TABLE user_id (
        internal_id text PRIMARY KEY,
        state text,
        deleted_at timestamptz,
        deletion_id uuid,
        welcome_bonus_at timestamptz
      );
    `);
    // smm_* — дословная копия CREATE TABLE из 001_core_schema.sql
    // (строки 8055-8280; без schema-квалификатора, search_path теста).
    await pool.query(`
      CREATE TABLE smm_billing_ledger (
          id uuid DEFAULT gen_random_uuid() NOT NULL,
          user_id text NOT NULL,
          video_id uuid,
          amount integer NOT NULL,
          op text NOT NULL,
          reason text NOT NULL,
          created_at timestamp with time zone DEFAULT now() NOT NULL,
          CONSTRAINT smm_billing_ledger_op_check CHECK ((op = ANY (ARRAY['charge'::text, 'refund'::text])))
      );
      CREATE TABLE smm_campaign (
          id uuid DEFAULT gen_random_uuid() NOT NULL,
          user_id text NOT NULL,
          conversation_id uuid,
          topic text,
          source_mode text NOT NULL,
          requested_count integer NOT NULL,
          status text DEFAULT 'drafting'::text NOT NULL,
          created_at timestamp with time zone DEFAULT now() NOT NULL,
          updated_at timestamp with time zone DEFAULT now() NOT NULL,
          is_linkeon_official boolean DEFAULT false NOT NULL,
          CONSTRAINT smm_campaign_requested_count_check CHECK (((requested_count > 0) AND (requested_count <= 20))),
          CONSTRAINT smm_campaign_source_mode_check CHECK ((source_mode = ANY (ARRAY['auto'::text, 'topic'::text, 'trends'::text]))),
          CONSTRAINT smm_campaign_status_check CHECK ((status = ANY (ARRAY['drafting'::text, 'approved'::text, 'done'::text, 'cancelled'::text])))
      );
      CREATE TABLE smm_creator_campaign (
          campaign_id uuid NOT NULL,
          cta_handle text NOT NULL,
          cta_label text DEFAULT 'Подписывайся'::text NOT NULL,
          voice_gender text NOT NULL,
          genre text DEFAULT 'dialog'::text NOT NULL,
          created_at timestamp with time zone DEFAULT now() NOT NULL,
          updated_at timestamp with time zone DEFAULT now() NOT NULL,
          logo_url text,
          cta_slogan text,
          publish_caption text,
          bg_color text,
          bg_image_url text,
          CONSTRAINT smm_creator_campaign_genre_check CHECK ((genre = ANY (ARRAY['dialog'::text, 'monologue'::text, 'fact_explanation'::text]))),
          CONSTRAINT smm_creator_campaign_voice_gender_check CHECK ((voice_gender = ANY (ARRAY['male'::text, 'female'::text])))
      );
      CREATE TABLE smm_event_log (
          id uuid DEFAULT gen_random_uuid() NOT NULL,
          event_type text NOT NULL,
          video_id uuid,
          publication_id uuid,
          payload jsonb,
          created_at timestamp with time zone DEFAULT now() NOT NULL
      );
      CREATE TABLE smm_music_track (
          id text NOT NULL,
          title text NOT NULL,
          mood text NOT NULL,
          duration_sec integer NOT NULL,
          storage_key text NOT NULL,
          license text,
          created_at timestamp with time zone DEFAULT now() NOT NULL,
          CONSTRAINT smm_music_track_mood_check CHECK ((mood = ANY (ARRAY['dramatic'::text, 'inspiring'::text, 'calm'::text, 'uplifting'::text, 'tense'::text, 'neutral'::text])))
      );
      CREATE TABLE smm_oauth_state (
          state text NOT NULL,
          user_id text NOT NULL,
          platform text NOT NULL,
          redirect_url text,
          created_at timestamp with time zone DEFAULT now() NOT NULL,
          CONSTRAINT smm_oauth_state_platform_check CHECK ((platform = ANY (ARRAY['vk'::text, 'youtube'::text, 'tiktok'::text, 'instagram'::text])))
      );
      CREATE TABLE smm_premium_generation (
          id uuid DEFAULT gen_random_uuid() NOT NULL,
          video_id uuid,
          user_id text NOT NULL,
          genre text NOT NULL,
          scene_count integer NOT NULL,
          tokens_charged integer NOT NULL,
          tokens_refunded integer DEFAULT 0 NOT NULL,
          status text NOT NULL,
          internal_cost_cents integer,
          created_at timestamp with time zone DEFAULT now() NOT NULL,
          completed_at timestamp with time zone
      );
      CREATE TABLE smm_pricing (
          id text NOT NULL,
          tokens_cost integer NOT NULL,
          display_name text NOT NULL,
          description text,
          active boolean DEFAULT true NOT NULL,
          updated_at timestamp with time zone DEFAULT now() NOT NULL,
          CONSTRAINT smm_pricing_id_check CHECK ((id = ANY (ARRAY['economy'::text, 'premium'::text]))),
          CONSTRAINT smm_pricing_tokens_cost_check CHECK ((tokens_cost > 0))
      );
      CREATE TABLE smm_publication (
          id uuid DEFAULT gen_random_uuid() NOT NULL,
          video_id uuid NOT NULL,
          platform text NOT NULL,
          scheduled_at timestamp with time zone,
          status text DEFAULT 'scheduled'::text NOT NULL,
          publish_job_id text,
          external_url text,
          external_post_id text,
          caption text,
          error_message text,
          published_at timestamp with time zone,
          created_at timestamp with time zone DEFAULT now() NOT NULL,
          updated_at timestamp with time zone DEFAULT now() NOT NULL,
          CONSTRAINT smm_publication_platform_check CHECK ((platform = ANY (ARRAY['telegram'::text, 'vk'::text, 'youtube'::text, 'tiktok'::text, 'instagram'::text]))),
          CONSTRAINT smm_publication_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'publishing'::text, 'published'::text, 'failed'::text, 'cancelled'::text])))
      );
      CREATE TABLE smm_scenario (
          id uuid DEFAULT gen_random_uuid() NOT NULL,
          campaign_id uuid NOT NULL,
          title text NOT NULL,
          assistant_role text NOT NULL,
          dialog jsonb NOT NULL,
          mood text NOT NULL,
          broll_prompts jsonb DEFAULT '[]'::jsonb NOT NULL,
          music_track_id text,
          tts_tier text DEFAULT 'premium'::text NOT NULL,
          status text DEFAULT 'pending_review'::text NOT NULL,
          created_at timestamp with time zone DEFAULT now() NOT NULL,
          updated_at timestamp with time zone DEFAULT now() NOT NULL,
          tts_voice_id text,
          premium_genre text,
          kling_scene_count integer DEFAULT 0 NOT NULL,
          scenes_json jsonb,
          CONSTRAINT premium_genre_check CHECK (((premium_genre IS NULL) OR (premium_genre = ANY (ARRAY['surreal'::text, 'pov'::text, 'cinematic'::text])))),
          CONSTRAINT smm_scenario_status_check CHECK ((status = ANY (ARRAY['pending_review'::text, 'approved'::text, 'rejected'::text, 'regenerating'::text]))),
          CONSTRAINT smm_scenario_tts_tier_check CHECK ((tts_tier = ANY (ARRAY['economy'::text, 'premium'::text])))
      );
      CREATE TABLE smm_social_account (
          id uuid DEFAULT gen_random_uuid() NOT NULL,
          user_id text,
          platform text NOT NULL,
          display_name text NOT NULL,
          credentials jsonb NOT NULL,
          status text DEFAULT 'active'::text NOT NULL,
          expires_at timestamp with time zone,
          created_at timestamp with time zone DEFAULT now() NOT NULL,
          updated_at timestamp with time zone DEFAULT now() NOT NULL,
          CONSTRAINT smm_social_account_platform_check CHECK ((platform = ANY (ARRAY['telegram'::text, 'vk'::text, 'youtube'::text, 'tiktok'::text, 'instagram'::text]))),
          CONSTRAINT smm_social_account_status_check CHECK ((status = ANY (ARRAY['active'::text, 'expired'::text, 'revoked'::text])))
      );
      CREATE TABLE smm_video (
          id uuid DEFAULT gen_random_uuid() NOT NULL,
          scenario_id uuid NOT NULL,
          status text DEFAULT 'queued'::text NOT NULL,
          render_job_id text,
          render_state jsonb DEFAULT '{}'::jsonb NOT NULL,
          mp4_url text,
          duration_sec integer,
          size_bytes bigint,
          error_message text,
          tokens_charged integer DEFAULT 0 NOT NULL,
          created_at timestamp with time zone DEFAULT now() NOT NULL,
          updated_at timestamp with time zone DEFAULT now() NOT NULL,
          CONSTRAINT smm_video_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'rendering'::text, 'ready'::text, 'failed'::text, 'approved'::text, 'rejected'::text, 'escape_hatch_offered'::text, 'cancelled'::text])))
      );
    `);
    // PK/UNIQUE — дословно из 001_core_schema.sql (10749-10853). FOREIGN KEYS
    // у smm_* отсутствуют (ловушка плана подтверждена схемой).
    await pool.query(`
      ALTER TABLE ONLY smm_billing_ledger ADD CONSTRAINT smm_billing_ledger_pkey PRIMARY KEY (id);
      ALTER TABLE ONLY smm_campaign ADD CONSTRAINT smm_campaign_pkey PRIMARY KEY (id);
      ALTER TABLE ONLY smm_creator_campaign ADD CONSTRAINT smm_creator_campaign_pkey PRIMARY KEY (campaign_id);
      ALTER TABLE ONLY smm_event_log ADD CONSTRAINT smm_event_log_pkey PRIMARY KEY (id);
      ALTER TABLE ONLY smm_music_track ADD CONSTRAINT smm_music_track_pkey PRIMARY KEY (id);
      ALTER TABLE ONLY smm_oauth_state ADD CONSTRAINT smm_oauth_state_pkey PRIMARY KEY (state);
      ALTER TABLE ONLY smm_premium_generation ADD CONSTRAINT smm_premium_generation_pkey PRIMARY KEY (id);
      ALTER TABLE ONLY smm_pricing ADD CONSTRAINT smm_pricing_pkey PRIMARY KEY (id);
      ALTER TABLE ONLY smm_publication ADD CONSTRAINT smm_publication_pkey PRIMARY KEY (id);
      ALTER TABLE ONLY smm_publication ADD CONSTRAINT smm_publication_video_id_platform_key UNIQUE (video_id, platform);
      ALTER TABLE ONLY smm_scenario ADD CONSTRAINT smm_scenario_pkey PRIMARY KEY (id);
      ALTER TABLE ONLY smm_social_account ADD CONSTRAINT smm_social_account_pkey PRIMARY KEY (id);
      ALTER TABLE ONLY smm_video ADD CONSTRAINT smm_video_pkey PRIMARY KEY (id);
      ALTER TABLE ONLY smm_video ADD CONSTRAINT smm_video_scenario_id_key UNIQUE (scenario_id);
    `);

    adapter = new LegacySmmAccountDeletionAdapter(makePg(), new AccountDeletionRegistry());
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE smm_billing_ledger, smm_campaign, smm_creator_campaign, smm_event_log,
                smm_music_track, smm_oauth_state, smm_premium_generation, smm_pricing,
                smm_publication, smm_scenario, smm_social_account, smm_video, user_id`,
    );
    await seedUser(USER, 'deleted', deletionId);
    await seedUser(OTHER, 'active');
    await seedShared();
  });

  it('legacy SMM scrub не удаляет billing evidence и official campaign (RED-тест плана)', async () => {
    const own = await seedOwnWorld();
    const officialId = await seedCampaign(USER, { official: true, topic: OFFICIAL_TOPIC });
    await seedSocialAccount(USER);
    await seedOauthState(USER);
    const before = await billingSnapshot();

    await runDeletion([own.campaignId]);

    const db = await readDb();
    expect(db.socialAccounts[0]).toMatchObject({ status: 'revoked' });
    expect(db.socialAccounts[0].credentials).toEqual({});
    expect(db.oauthStates).toHaveLength(0);
    expect(db.campaigns.find((c) => c.id === own.campaignId)!.topic).toBeNull();
    expect(db.campaigns.find((c) => c.id === own.campaignId)!.conversation_id).toBeNull();
    expect(db.scenarios[0]).toMatchObject({ title: '' });
    expect(db.scenarios[0].dialog).toEqual([]);
    expect(db.scenarios[0].broll_prompts).toEqual([]);
    expect(db.scenarios[0].scenes_json).toBeNull();
    expect(db.videos[0]).toMatchObject({ mp4_url: null, error_message: null });
    expect(db.videos[0].render_state).toEqual({});
    expect(db.publications[0]).toMatchObject({
      caption: null, external_url: null, external_post_id: null, error_message: null,
    });
    expect(db.creatorCampaigns[0]).toMatchObject({
      cta_handle: '', cta_label: '', logo_url: null, cta_slogan: null,
      publish_caption: null, bg_image_url: null,
    });
    // Billing evidence: строки и все суммы — байт-в-байт.
    expect(await billingSnapshot()).toBe(before);
    // Shared/official не выбраны и не тронуты.
    expect(db.campaigns.find((c) => c.id === officialId)!.topic).toBe(OFFICIAL_TOPIC);
    expect(db.musicTracks).toHaveLength(1);
    expect(db.pricing).toHaveLength(1);

    // Canary: личный текст, URL и credentials исчезли из всех smm-таблиц.
    // USER не входит в глобальный список: план алиасит user_id только в
    // ledger/premium_generation; smm_campaign.user_id и
    // smm_social_account.user_id по плану сохраняются (см. отчёт).
    const dump = await fullDump();
    for (const canary of [
      TOPIC_CANARY, DIALOG_CANARY, SCENES_CANARY, BROLL_CANARY, CAPTION_CANARY,
      CRED_CANARY, CTA_HANDLE_CANARY, CTA_SLOGAN_CANARY, PUBLISH_CAPTION_CANARY,
      LOGO_CANARY, BG_CANARY, MP4_CANARY, EXTERNAL_URL_CANARY, RENDER_CANARY,
      ERROR_CANARY, CONVERSATION_ID, EVENT_CANARY,
    ]) {
      expect(dump).not.toContain(canary);
    }
    expect(dump).toContain(ALIAS);
    // Идентичность исчезла из billing-таблиц (alias) и из oauth (DELETE).
    expect(await rows(`SELECT count(*)::int AS n FROM smm_billing_ledger WHERE user_id=$1`, [USER]))
      .toEqual([{ n: 0 }]);
    expect(await rows(`SELECT count(*)::int AS n FROM smm_premium_generation WHERE user_id=$1`, [USER]))
      .toEqual([{ n: 0 }]);
  });

  it('собственные smm_event_log (video/publication) удаляются; чужие и непринадлежащие остаются', async () => {
    const own = await seedOwnWorld();
    const otherCampaign = await seedCampaign(OTHER, { topic: 'other topic' });
    const otherScenario = await seedScenario(otherCampaign);
    const otherVideo = await seedVideo(otherScenario);
    const ownVideoEvent = await seedEventLog({ videoId: own.videoId });
    const ownPubEvent = await seedEventLog({ publicationId: own.publicationId, eventType: 'publish_step' });
    const otherEvent = await seedEventLog({ videoId: otherVideo });
    const orphanEvent = await seedEventLog({ eventType: 'system_step' });

    await runDeletion([own.campaignId]);

    const left = await rows(`SELECT id FROM smm_event_log ORDER BY created_at, id`);
    expect(left.map((r) => r.id).sort()).toEqual([orphanEvent, otherEvent].sort());
    expect(left).not.toContainEqual({ id: ownVideoEvent });
    expect(left).not.toContainEqual({ id: ownPubEvent });
  });

  it('stop: активные campaign/video/publication → cancelled, терминальные не трогаются', async () => {
    const active = await seedOwnWorld({
      campaignStatus: 'drafting', videoStatus: 'queued', publicationStatus: 'publishing',
    });
    // Терминальная цепочка той же кампании: отдельный video+publication
    // (UNIQUE(video_id,platform) позволяет другую платформу на том же video).
    const publishedId = await seedPublication(active.videoId, 'telegram', {
      status: 'published', externalPostId: null, externalUrl: null, caption: null,
    });
    const doneCampaign = await seedCampaign(USER, { topic: 'done topic', status: 'done' });
    const doneScenario = await seedScenario(doneCampaign);
    const doneVideo = await seedVideo(doneScenario, { status: 'failed' });

    await adapter.execute(jobRow('legacy-smm.stop', active.campaignId), makeCtx());
    await adapter.execute(jobRow('legacy-smm.stop', doneCampaign), makeCtx());

    expect(await rows(`SELECT status FROM smm_campaign WHERE id=$1`, [active.campaignId]))
      .toEqual([{ status: 'cancelled' }]);
    expect(await rows(`SELECT status FROM smm_video WHERE id=$1`, [active.videoId]))
      .toEqual([{ status: 'cancelled' }]);
    expect(await rows(`SELECT status FROM smm_publication WHERE id=$1`, [active.publicationId]))
      .toEqual([{ status: 'cancelled' }]);
    // published — внешний факт, терминальный: остаётся.
    expect(await rows(`SELECT status FROM smm_publication WHERE id=$1`, [publishedId]))
      .toEqual([{ status: 'published' }]);
    // done-кампания и failed-видео — терминальные: остаются.
    expect(await rows(`SELECT status FROM smm_campaign WHERE id=$1`, [doneCampaign]))
      .toEqual([{ status: 'done' }]);
    expect(await rows(`SELECT status FROM smm_video WHERE id=$1`, [doneVideo]))
      .toEqual([{ status: 'failed' }]);
  });

  it('внешний пост: discovery даёт unsupported_external skip, purge стирает external ID/URL (внешних вызовов нет)', async () => {
    const own = await seedOwnWorld({
      publicationStatus: 'published', externalPostId: EXTERNAL_ID_CANARY,
    });

    const plan = await discoverLegacySmmDeletion(discoveryCtx());

    expect(plan.skips).toEqual([
      { resourceType: 'legacy-smm.purge', reason: 'unsupported_external' } satisfies DeletionSkip,
    ]);
    for (const skip of plan.skips) expect(() => assertSafeSkip(skip)).not.toThrow();
    // Официальные кампании того же user_id в план не попадают; user-scoped
    // пара присутствует (есть ledger/premium строки пользователя).
    expect(plan.jobs.filter((j) => j.resourceKey === own.campaignId)).toHaveLength(2);
    expect(plan.jobs.filter((j) => j.resourceKey === USER_KEY)).toHaveLength(2);
    expect(plan.jobs).toHaveLength(4);

    await runDeletion([own.campaignId]);

    expect(await rows(`SELECT external_post_id, external_url, caption FROM smm_publication WHERE id=$1`,
      [own.publicationId]))
      .toEqual([{ external_post_id: null, external_url: null, caption: null }]);
  });

  it('alias: ledger и premium_generation получают deleted:<deletionId> (44 символа, text), суммы и строки целы', async () => {
    const own = await seedOwnWorld();
    const otherLedger = await seedLedger(OTHER, { amount: 50, op: 'charge' });
    const before = await billingSnapshot();

    await runDeletion([own.campaignId]);

    expect(ALIAS).toHaveLength(44);
    expect(await rows(`SELECT DISTINCT user_id FROM smm_billing_ledger WHERE video_id=$1`, [own.videoId]))
      .toEqual([{ user_id: ALIAS }]);
    expect(await rows(`SELECT DISTINCT user_id FROM smm_premium_generation WHERE video_id=$1`, [own.videoId]))
      .toEqual([{ user_id: ALIAS }]);
    // Чужие строки ledger не тронуты.
    expect(await rows(`SELECT user_id FROM smm_billing_ledger WHERE id=$1`, [otherLedger]))
      .toEqual([{ user_id: OTHER }]);
    expect(await billingSnapshot()).toBe(before);
  });

  it('общие таблицы и official-кампания не выбираются и остаются байт-в-байт', async () => {
    const own = await seedOwnWorld();
    const officialId = await seedCampaign(USER, { official: true, topic: OFFICIAL_TOPIC, status: 'drafting' });
    const officialScenario = await seedScenario(officialId, { title: 'official scenario' });
    await seedVideo(officialScenario, { status: 'queued' });
    const musicBefore = JSON.stringify(await rows(`SELECT * FROM smm_music_track`));
    const pricingBefore = JSON.stringify(await rows(`SELECT * FROM smm_pricing`));
    const officialBefore = JSON.stringify(await rows(
      `SELECT c.*, s.title, s.dialog, v.status AS video_status, v.render_state
         FROM smm_campaign c
         JOIN smm_scenario s ON s.campaign_id = c.id
         JOIN smm_video v ON v.scenario_id = s.id
        WHERE c.id = $1`, [officialId]));

    const plan = await discoverLegacySmmDeletion(discoveryCtx());
    const campaignKeys = plan.jobs
      .filter((j) => j.resourceKey !== USER_KEY)
      .map((j) => j.resourceKey);
    expect(campaignKeys).toEqual([own.campaignId, own.campaignId]);

    await runDeletion([own.campaignId]);

    expect(JSON.stringify(await rows(`SELECT * FROM smm_music_track`))).toBe(musicBefore);
    expect(JSON.stringify(await rows(`SELECT * FROM smm_pricing`))).toBe(pricingBefore);
    expect(JSON.stringify(await rows(
      `SELECT c.*, s.title, s.dialog, v.status AS video_status, v.render_state
         FROM smm_campaign c
         JOIN smm_scenario s ON s.campaign_id = c.id
         JOIN smm_video v ON v.scenario_id = s.id
        WHERE c.id = $1`, [officialId]))).toBe(officialBefore);
  });

  it('чужие кампании/аккаунты/ledger не тронуты', async () => {
    const own = await seedOwnWorld();
    const otherCampaign = await seedCampaign(OTHER, { topic: 'other topic', status: 'approved' });
    await seedCreatorCampaign(otherCampaign);
    const otherScenario = await seedScenario(otherCampaign);
    const otherVideo = await seedVideo(otherScenario);
    const otherPub = await seedPublication(otherVideo, 'youtube');
    await seedSocialAccount(OTHER, { platform: 'youtube' });
    await seedOauthState(OTHER, 'youtube');
    await seedLedger(OTHER, { videoId: otherVideo, amount: 900, op: 'charge' });
    await seedPremium(OTHER, { videoId: otherVideo });
    const otherDumpKeys = `
      SELECT json_build_object(
        'campaign', (SELECT to_jsonb(x) FROM smm_campaign x WHERE id=$1),
        'creator', (SELECT to_jsonb(x) FROM smm_creator_campaign x WHERE campaign_id=$1),
        'scenario', (SELECT to_jsonb(x) FROM smm_scenario x WHERE id=$2),
        'video', (SELECT to_jsonb(x) FROM smm_video x WHERE id=$3),
        'publication', (SELECT to_jsonb(x) FROM smm_publication x WHERE id=$4),
        'social', (SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM smm_social_account x WHERE user_id=$5 ORDER BY created_at) x),
        'oauth', (SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM smm_oauth_state x WHERE user_id=$5 ORDER BY state) x),
        'ledger', (SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM smm_billing_ledger x WHERE user_id=$5 ORDER BY created_at) x),
        'premium', (SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM smm_premium_generation x WHERE user_id=$5 ORDER BY created_at) x)
      ) AS d`;
    const before = JSON.stringify(
      (await rows(otherDumpKeys, [otherCampaign, otherScenario, otherVideo, otherPub, OTHER]))[0].d);

    await runDeletion([own.campaignId]);

    const after = JSON.stringify(
      (await rows(otherDumpKeys, [otherCampaign, otherScenario, otherVideo, otherPub, OTHER]))[0].d);
    expect(after).toBe(before);
    expect(after).toContain(OTHER);
    expect(after).not.toContain(ALIAS);
  });

  it('идемпотентность: повторные stop+purge — дамп байт-в-байт', async () => {
    const own = await seedOwnWorld();
    await seedSocialAccount(USER);
    await seedOauthState(USER);

    await runDeletion([own.campaignId]);
    const first = await fullDump();

    await expect(runDeletion([own.campaignId])).resolves.toBeUndefined();

    const second = await fullDump();
    expect(second).toBe(first);
    expect(second).toContain(ALIAS);
    expect(second).not.toContain(TOPIC_CANARY);
  });

  it('generation mismatch — тихий успех, строки не тронуты', async () => {
    const own = await seedOwnWorld();
    await seedSocialAccount(USER);
    await seedOauthState(USER);
    const before = await fullDump();
    // Другое поколение удаления (реактивация + новое удаление).
    await pool.query(`UPDATE user_id SET deletion_id=$1 WHERE internal_id=$2`, [randomUUID(), USER]);

    await expect(runDeletion([own.campaignId])).resolves.toBeUndefined();

    expect(await fullDump()).toBe(before);
    expect(await rows(`SELECT credentials->>'access_token' AS t FROM smm_social_account`))
      .toEqual([{ t: CRED_CANARY }]);
    expect(await rows(`SELECT count(*)::int AS n FROM smm_oauth_state`)).toEqual([{ n: 1 }]);
  });

  it('reactivation между discovery и execute — DeletionCancelledError, записи нет', async () => {
    const own = await seedOwnWorld();
    await seedSocialAccount(USER);
    const before = await fullDump();
    const ctx = makeCtx();
    ctx.assertCurrent.mockRejectedValue(new DeletionCancelledError());

    // Все четыре jobа (user-scoped пара и campaign-пара) отменяются до записи.
    await expect(adapter.execute(userScopedJobRow('legacy-smm.stop'), ctx))
      .rejects.toBeInstanceOf(DeletionCancelledError);
    await expect(adapter.execute(jobRow('legacy-smm.stop', own.campaignId), ctx))
      .rejects.toBeInstanceOf(DeletionCancelledError);
    await expect(adapter.execute(jobRow('legacy-smm.purge', own.campaignId), ctx))
      .rejects.toBeInstanceOf(DeletionCancelledError);
    await expect(adapter.execute(userScopedJobRow('legacy-smm.purge'), ctx))
      .rejects.toBeInstanceOf(DeletionCancelledError);

    expect(await fullDump()).toBe(before);
  });

  it('чужой campaignId в payload (валидный uuid, не свой) — ничего не меняет', async () => {
    const own = await seedOwnWorld();
    const otherCampaign = await seedCampaign(OTHER, { topic: 'other topic' });
    const before = await fullDump();

    await adapter.execute(jobRow('legacy-smm.stop', otherCampaign), makeCtx());
    await adapter.execute(jobRow('legacy-smm.purge', otherCampaign), makeCtx());

    const after = await fullDump();
    // Чужая кампания не тронута: per-campaign stop/purge гейтятся
    // OWN_CAMPAIGN_PREDICATE (c.user_id=$1 AND c.id=$3), чужой id даёт 0 строк.
    expect(after).toBe(before);
    expect(after).toContain(TOPIC_CANARY);
    expect(await rows(`SELECT topic FROM smm_campaign WHERE id=$1`, [own.campaignId]))
      .toEqual([{ topic: TOPIC_CANARY }]);
  });

  it('пользователь без кампаний: credentials отзываются, oauth удаляется, billing алиасится', async () => {
    // Ни одной smm_campaign — только user-scoped след. Design-спек (строка 44):
    // секреты соединения удаляются по действующим правилам, БЕЗ условия
    // наличия кампаний.
    await seedSocialAccount(USER);
    await seedOauthState(USER);
    await seedLedger(USER, { amount: 1000, op: 'charge' });
    await seedPremium(USER);
    const before = await billingSnapshot();

    const plan = await discoverLegacySmmDeletion(discoveryCtx());
    expect(plan.jobs).toEqual([
      { resourceType: 'legacy-smm.stop', resourceKey: USER_KEY, phase: 'immediate', payload: {} },
      { resourceType: 'legacy-smm.purge', resourceKey: USER_KEY, phase: 'purge', payload: {} },
    ]);
    expect(plan.skips).toEqual([]);

    await adapter.execute(userScopedJobRow('legacy-smm.stop'), makeCtx());
    await adapter.execute(userScopedJobRow('legacy-smm.purge'), makeCtx());

    const db = await readDb();
    expect(db.socialAccounts).toHaveLength(1);
    expect(db.socialAccounts[0].status).toBe('revoked');
    expect(db.socialAccounts[0].credentials).toEqual({});
    expect(db.oauthStates).toHaveLength(0);

    // Billing сохранён байт-в-байт; user_id заменён alias-ом (44 символа).
    expect(await billingSnapshot()).toBe(before);
    expect(ALIAS).toHaveLength(44);
    expect(await rows(`SELECT DISTINCT user_id FROM smm_billing_ledger`))
      .toEqual([{ user_id: ALIAS }]);
    expect(await rows(`SELECT DISTINCT user_id FROM smm_premium_generation`))
      .toEqual([{ user_id: ALIAS }]);

    const dump = await fullDump();
    expect(dump).not.toContain(CRED_CANARY);
    expect(dump).toContain(ALIAS);
    // smm_social_account.user_id остаётся: план алиасит только ledger/premium.
    expect(dump).toContain(USER);
  });

  it('per-campaign stop не трогает user-scoped данные (social/oauth)', async () => {
    const own = await seedOwnWorld();
    await seedSocialAccount(USER);
    await seedOauthState(USER);
    const beforeSocial = JSON.stringify(await rows(`SELECT * FROM smm_social_account`));
    const beforeOauth = JSON.stringify(await rows(`SELECT * FROM smm_oauth_state`));

    await adapter.execute(jobRow('legacy-smm.stop', own.campaignId), makeCtx());

    // Кампания остановлена, но social/oauth — байт-в-байт без изменений.
    expect(await rows(`SELECT status FROM smm_campaign WHERE id=$1`, [own.campaignId]))
      .toEqual([{ status: 'cancelled' }]);
    expect(JSON.stringify(await rows(`SELECT * FROM smm_social_account`))).toBe(beforeSocial);
    expect(JSON.stringify(await rows(`SELECT * FROM smm_oauth_state`))).toBe(beforeOauth);
    expect(await rows(`SELECT credentials->>'access_token' AS t FROM smm_social_account`))
      .toEqual([{ t: CRED_CANARY }]);

    // Секреты отзывает только user-scoped stop.
    await adapter.execute(userScopedJobRow('legacy-smm.stop'), makeCtx());
    expect(await rows(`SELECT status, credentials::text AS c FROM smm_social_account`))
      .toEqual([{ status: 'revoked', c: '{}' }]);
    expect(await rows(`SELECT count(*)::int AS n FROM smm_oauth_state`)).toEqual([{ n: 0 }]);
  });

  it('нет кампаний и user-scoped строк — discovery возвращает пустой план', async () => {
    // В базе только данные OTHER и общие таблицы — для USER работы нет.
    await seedSocialAccount(OTHER);
    await seedOauthState(OTHER);
    await seedLedger(OTHER, { amount: 10, op: 'charge' });
    await seedPremium(OTHER);

    const plan = await discoverLegacySmmDeletion(discoveryCtx());
    expect(plan).toEqual({ jobs: [], skips: [] });
  });
});
