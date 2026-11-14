import { BadRequestException } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import { DELETION_DISCOVERERS } from '../account-deletion/account-deletion.catalog';
import {
  DeletionCancelledError,
  safeDeletionJobSnapshot,
} from '../account-deletion/account-deletion.safe';
import type {
  DeletionAccount,
  DeletionExecution,
  DeletionJobRow,
} from '../account-deletion/account-deletion.types';
import { PeerModule } from './peer.module';
import { PeerService } from './peer.service';
import {
  discoverPeerDeletion,
  PeerAccountDeletionAdapter,
} from './peer-account-deletion.adapter';

/**
 * Task 17B — peer: redact/tombstone вместо удаления shared history.
 *
 * PG-часть обязательна: LEAST/GREATEST-алиасинг peer_conversations должен
 * выдерживать CHECK (user_a_id < user_b_id) и UNIQUE(user_a_id,user_b_id),
 * partial unique uniq_chat_requests_pending и PK/CHECK user_blocks — на фейке
 * констрейнты не проверить. Схема поднимается из настоящего миграционного
 * файла src/peer/migrations/001_peer_tables.sql (направление чек-листа
 * T13/14/15-M2), не инлайн-DDL.
 *
 * Семантика (план): сообщения удалённого удаляются, сообщения второго
 * участника сохраняются; свои ID в chat_requests/peer_conversations/
 * user_blocks(incoming)/user_reports заменяются deletion-scoped alias
 * 'deleted:<deletionId>'; intro_message своих requests очищается; outgoing
 * blocks удаляются; reason/context жалоб сохраняются (security-retention).
 * user_id.internal_id и ai_profiles_consolidated.id НЕ переименовываются.
 */

const USER = 'u-deleted';
const OTHER = 'u-other';
const LONE_CANARY = 'СЕКРЕТ-НЕ-ЛОГИРОВАТЬ';
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

function jobRow(resourceType: 'peer.stop' | 'peer.purge', overrides: Partial<DeletionJobRow> = {}): DeletionJobRow {
  return {
    id: `job-${resourceType}`,
    deletionId,
    userId: USER,
    resourceType,
    resourceKey: 'peer',
    phase: resourceType === 'peer.stop' ? 'immediate' : 'purge',
    payload: {},
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date('2026-12-14T00:00:00Z'),
    leaseUntil: new Date('2026-12-14T01:00:00Z'),
    lastErrorKind: null,
    ...overrides,
  };
}

describe('discoverPeerDeletion — stop+purge, пустые payload (Task 17B)', () => {
  it('два jobа: peer.stop immediate и peer.purge purge; sanitizer плана проходит', async () => {
    const db = new FakeGenDb(true);

    const plan = await discoverPeerDeletion({ db, account, origin: 'explicit' });

    expect(plan.jobs).toEqual([
      { resourceType: 'peer.stop', resourceKey: 'peer', phase: 'immediate', payload: {} },
      { resourceType: 'peer.purge', resourceKey: 'peer', phase: 'purge', payload: {} },
    ]);
    expect(plan.skips).toEqual([]);
    const json = JSON.stringify(plan.jobs);
    expect(json).not.toContain(USER);
    expect(json).not.toContain(LONE_CANARY);
    for (const job of plan.jobs) {
      expect(() => safeDeletionJobSnapshot(job, USER)).not.toThrow();
    }
    // Discovery НЕ читает peer-таблицы — только generation gate (intro/контент
    // сообщений в план не поднимаются).
    expect(db.queries.every((q) => q.sql.startsWith('SELECT 1 FROM user_id'))).toBe(true);
  });

  it('reactivation (поколение не совпало) — план пустой', async () => {
    const db = new FakeGenDb(false);

    const plan = await discoverPeerDeletion({ db, account, origin: 'explicit' });

    expect(plan).toEqual({ jobs: [], skips: [] });
  });
});

describe('wiring peer.stop/peer.purge (Task 17B)', () => {
  it('adapter регистрирует peer.stop и peer.purge, PeerModule его провайдит', () => {
    const registry = { register: jest.fn() } as any;
    const adapter = new PeerAccountDeletionAdapter(registry);
    expect(adapter.resourceTypes).toEqual(['peer.stop', 'peer.purge']);
    adapter.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(adapter);

    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, PeerModule) ?? []).flat(Infinity);
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, PeerModule) ?? [];
    expect(imports.filter((item: unknown) => item === AccountDeletionModule)).toHaveLength(1);
    expect(providers.filter((item: unknown) => item === PeerAccountDeletionAdapter)).toHaveLength(1);
  });

  it('catalog содержит discoverPeerDeletion ровно один раз', () => {
    expect(
      DELETION_DISCOVERERS.filter((item) => item === discoverPeerDeletion),
    ).toHaveLength(1);
  });

  it('чужой resourceType — отказ до любой записи', async () => {
    const db = new FakeGenDb(true);
    const adapter = new PeerAccountDeletionAdapter(new AccountDeletionRegistry());
    const ctx: DeletionExecution = { db, assertCurrent: jest.fn(async () => undefined) };

    await expect(
      adapter.execute(jobRow('peer.purge', { resourceType: 'avatar.purge' }), ctx),
    ).rejects.toThrow('unsupported_deletion_resource');
    expect(ctx.assertCurrent).not.toHaveBeenCalled();
    expect(db.queries).toHaveLength(0);
  });
});

// ==================== PG-часть ====================

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `peer_acct_del_spec_${process.pid}`;
const MIGRATION = path.join(__dirname, 'migrations', '001_peer_tables.sql');

maybe('peer account deletion against PostgreSQL (Task 17B)', () => {
  jest.setTimeout(30_000);

  let admin: Pool;
  let pool: Pool;
  let adapter: PeerAccountDeletionAdapter;

  function makeCtx(): DeletionExecution & { assertCurrent: jest.Mock } {
    return {
      db: { query: (sql: string, params?: unknown[]) => pool.query(sql, params as any[]) },
      assertCurrent: jest.fn(async () => undefined),
    };
  }

  async function seedUser(id: string, state: 'active' | 'deleted' = 'active', delId: string | null = null) {
    await pool.query(
      `INSERT INTO user_id (internal_id,state,deleted_at,deletion_id) VALUES ($1,$2,$3,$4)`,
      [id, state, state === 'deleted' ? DELETED_AT : null, delId],
    );
  }

  async function seedConversation(a: string, b: string): Promise<string> {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const r = await pool.query(
      `INSERT INTO peer_conversations (user_a_id,user_b_id) VALUES ($1,$2) RETURNING id`,
      [lo, hi],
    );
    return r.rows[0].id;
  }

  async function seedMessage(conversationId: string, senderId: string, content: string, createdAt: string) {
    await pool.query(
      `INSERT INTO peer_messages (conversation_id,sender_id,content,created_at)
       VALUES ($1,$2,$3,$4::timestamptz)`,
      [conversationId, senderId, content, createdAt],
    );
  }

  async function seedRequest(from: string, to: string, intro: string, status = 'pending'): Promise<string> {
    const r = await pool.query(
      `INSERT INTO chat_requests (from_user_id,to_user_id,intro_message,status)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [from, to, intro, status],
    );
    return r.rows[0].id;
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 2, options: `-c search_path=${SCHEMA}` });
    // Настоящая peer-схема из миграционного файла (не инлайн-DDL).
    await pool.query(fs.readFileSync(MIGRATION, 'utf8'));
    // Минимальная user_id для generation gate (форма product-account-deletion.pg.spec).
    await pool.query(`CREATE TABLE user_id (
      internal_id text PRIMARY KEY,
      state text,
      deleted_at timestamptz,
      deletion_id uuid
    )`);
    adapter = new PeerAccountDeletionAdapter(new AccountDeletionRegistry());
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE peer_messages, peer_conversations, chat_requests, user_blocks, user_reports, user_id`,
    );
    await seedUser(USER, 'deleted', deletionId);
    await seedUser(OTHER, 'active');
  });

  async function rows(sql: string, params: any[] = []): Promise<any[]> {
    return (await pool.query(sql, params)).rows;
  }

  it('peer.stop: свои pending → withdrawn (с responded_at), чужой incoming не тронут', async () => {
    const mine = await seedRequest(USER, OTHER, 'мой интро');
    const theirs = await seedRequest(OTHER, USER, 'их интро');
    const ctx = makeCtx();

    await adapter.execute(jobRow('peer.stop'), ctx);

    const r = await rows(`SELECT id,status,responded_at,intro_message FROM chat_requests ORDER BY created_at`);
    expect(r.find((x) => x.id === mine)).toMatchObject({ status: 'withdrawn', intro_message: 'мой интро' });
    expect(r.find((x) => x.id === mine).responded_at).not.toBeNull();
    expect(r.find((x) => x.id === theirs)).toMatchObject({ status: 'pending', intro_message: 'их интро' });
    expect(ctx.assertCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'peer.stop' }),
    );
  });

  it('peer purge удаляет только свои messages и заменяет свои IDs на deletion alias', async () => {
    // Разговор и сообщения: своё удаляется, чужое сохраняется.
    const conv = await seedConversation(USER, OTHER);
    await seedMessage(conv, USER, LONE_CANARY, '2026-10-01T00:00:00Z');
    await seedMessage(conv, OTHER, 'reply stays', '2026-10-02T00:00:00Z');
    // Requests: свой (intro стирается), чужой в адрес удалённого (shared history).
    const mine = await seedRequest(USER, OTHER, LONE_CANARY, 'withdrawn');
    const theirs = await seedRequest(OTHER, USER, 'их интро');
    // Blocks: outgoing удалённого и incoming на удалённого.
    await pool.query(`INSERT INTO user_blocks (blocker_id,blocked_id) VALUES ($1,'u-victim')`, [USER]);
    await pool.query(`INSERT INTO user_blocks (blocker_id,blocked_id) VALUES ('u-blocker',$1)`, [USER]);
    // Reports: удалённый пожаловался и на удалённого пожаловались — reason сохраняется.
    await pool.query(
      `INSERT INTO user_reports (reporter_id,target_id,reason,context_type,context_id,status)
       VALUES ($1,'u-reported','moderation evidence','conversation',$2,'new')`,
      [USER, randomUUID()],
    );
    await pool.query(
      `INSERT INTO user_reports (reporter_id,target_id,reason,status,resolution)
       VALUES ('u-reporter2',$1,'abuse','resolved','warned')`,
      [USER],
    );
    const ctx = makeCtx();

    await adapter.execute(jobRow('peer.purge'), ctx);

    // 1. Сообщения: свои удалены, чужое сохранено целиком.
    const msgs = await rows(`SELECT sender_id,content FROM peer_messages ORDER BY created_at`);
    expect(msgs.map((m) => m.sender_id)).toEqual([OTHER]);
    expect(msgs[0].content).toBe('reply stays');
    // 2. Разговор жив, обе стороны — не userId, порядок пары сохранён.
    const convs = await rows(`SELECT user_a_id,user_b_id FROM peer_conversations`);
    expect(convs).toHaveLength(1);
    expect(convs[0].user_a_id < convs[0].user_b_id).toBe(true);
    expect(convs[0]).not.toMatchObject({ user_a_id: USER });
    expect(convs[0]).not.toMatchObject({ user_b_id: USER });
    expect([convs[0].user_a_id, convs[0].user_b_id].sort()).toEqual([ALIAS, OTHER].sort());
    // 3. Requests: intro своего очищен, чужой request остаётся с интро и alias в to.
    const reqs = await rows(`SELECT id,from_user_id,to_user_id,intro_message,status FROM chat_requests`);
    expect(reqs.find((r) => r.id === mine)).toMatchObject({
      from_user_id: ALIAS, to_user_id: OTHER, intro_message: '', status: 'withdrawn',
    });
    expect(reqs.find((r) => r.id === theirs)).toMatchObject({
      from_user_id: OTHER, to_user_id: ALIAS, intro_message: 'их интро', status: 'pending',
    });
    // 4. Blocks: outgoing удалён, incoming получил alias.
    const blocks = await rows(`SELECT blocker_id,blocked_id FROM user_blocks`);
    expect(blocks).toEqual([{ blocker_id: 'u-blocker', blocked_id: ALIAS }]);
    // 5. Reports: обе стороны алиасятся, reason/context/moderation-колонки целы.
    const reports = await rows(
      `SELECT reporter_id,target_id,reason,context_type,context_id,status,resolution
       FROM user_reports ORDER BY created_at`,
    );
    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({
      reporter_id: ALIAS, target_id: 'u-reported', reason: 'moderation evidence',
      context_type: 'conversation', status: 'new',
    });
    expect(reports[0].context_id).not.toBeNull();
    expect(reports[1]).toMatchObject({
      reporter_id: 'u-reporter2', target_id: ALIAS, reason: 'abuse',
      status: 'resolved', resolution: 'warned',
    });
    // Canary: собственный текст не остался ни в одной peer-таблице.
    const dump = JSON.stringify(await rows(
      `SELECT (SELECT jsonb_agg(to_jsonb(m)) FROM peer_messages m) AS msgs,
              (SELECT jsonb_agg(to_jsonb(r)) FROM chat_requests r) AS reqs`,
    ));
    expect(dump).not.toContain(LONE_CANARY);
    expect(ctx.assertCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'peer.purge' }),
    );
  });

  it('инвариант пары: LEAST/GREATEST держит user_a_id < user_b_id для партнёров с обеих сторон порядка', async () => {
    // 'a-user' < ALIAS < 'z-user': alias должен попасть в b и в a соответственно.
    const convLow = await seedConversation(USER, 'a-user');
    const convHigh = await seedConversation(USER, 'z-user');
    const untouched = await seedConversation('p-one', 'p-two');

    await adapter.execute(jobRow('peer.purge'), makeCtx());

    const byId = new Map(
      (await rows(`SELECT id,user_a_id,user_b_id FROM peer_conversations`)).map((r) => [r.id, r]),
    );
    expect(byId.get(convLow)).toMatchObject({ user_a_id: 'a-user', user_b_id: ALIAS });
    expect(byId.get(convHigh)).toMatchObject({ user_a_id: ALIAS, user_b_id: 'z-user' });
    expect(byId.get(untouched)).toMatchObject({ user_a_id: 'p-one', user_b_id: 'p-two' });
    // UNIQUE(user_a_id,user_b_id) не нарушен: все три пары различимы.
    expect(byId.size).toBe(3);
  });

  it('идемпотентность: повторный execute не меняет alias и не роняет unique-пары', async () => {
    const conv = await seedConversation(USER, OTHER);
    await seedMessage(conv, OTHER, 'reply stays', '2026-10-02T00:00:00Z');
    await seedRequest(OTHER, USER, 'их интро');
    await pool.query(`INSERT INTO user_blocks (blocker_id,blocked_id) VALUES ('u-blocker',$1)`, [USER]);

    await adapter.execute(jobRow('peer.purge'), makeCtx());
    const first = JSON.stringify(await rows(
      `SELECT (SELECT jsonb_agg(row_to_json(c)) FROM peer_conversations c) AS c,
              (SELECT jsonb_agg(row_to_json(r)) FROM chat_requests r) AS r,
              (SELECT jsonb_agg(row_to_json(b)) FROM user_blocks b) AS b`,
    ));

    await expect(adapter.execute(jobRow('peer.purge'), makeCtx())).resolves.toBeUndefined();

    const second = JSON.stringify(await rows(
      `SELECT (SELECT jsonb_agg(row_to_json(c)) FROM peer_conversations c) AS c,
              (SELECT jsonb_agg(row_to_json(r)) FROM chat_requests r) AS r,
              (SELECT jsonb_agg(row_to_json(b)) FROM user_blocks b) AS b`,
    ));
    expect(second).toBe(first);
    expect(second).toContain(ALIAS);
    expect(second).not.toContain(`"${USER}"`);
  });

  it('generation mismatch — тихий успех, строки не тронуты', async () => {
    // Другое поколение удаления (например, реактивация + новое удаление).
    await pool.query(`UPDATE user_id SET deletion_id=$1 WHERE internal_id=$2`, [randomUUID(), USER]);
    const conv = await seedConversation(USER, OTHER);
    await seedMessage(conv, USER, LONE_CANARY, '2026-10-01T00:00:00Z');
    await seedRequest(USER, OTHER, 'мой интро');

    await expect(adapter.execute(jobRow('peer.stop'), makeCtx())).resolves.toBeUndefined();
    await expect(adapter.execute(jobRow('peer.purge'), makeCtx())).resolves.toBeUndefined();

    expect(await rows(`SELECT sender_id FROM peer_messages`)).toEqual([{ sender_id: USER }]);
    const c = await rows(`SELECT user_a_id,user_b_id FROM peer_conversations WHERE id=$1`, [conv]);
    expect([c[0].user_a_id, c[0].user_b_id]).toEqual([USER, OTHER]);
    const r = await rows(`SELECT from_user_id,intro_message,status FROM chat_requests`);
    expect(r[0]).toMatchObject({ from_user_id: USER, intro_message: 'мой интро', status: 'pending' });
  });

  it('reactivation между discovery и execute — DeletionCancelledError, записи нет', async () => {
    const conv = await seedConversation(USER, OTHER);
    await seedMessage(conv, USER, LONE_CANARY, '2026-10-01T00:00:00Z');
    const ctx = makeCtx();
    ctx.assertCurrent.mockRejectedValue(new DeletionCancelledError());

    await expect(adapter.execute(jobRow('peer.purge'), ctx)).rejects.toBeInstanceOf(DeletionCancelledError);

    const msgs = await rows(`SELECT sender_id FROM peer_messages ORDER BY created_at`);
    expect(msgs.map((m) => m.sender_id)).toEqual([USER]);
    const c = await rows(`SELECT user_a_id,user_b_id FROM peer_conversations WHERE id=$1`, [conv]);
    expect([c[0].user_a_id, c[0].user_b_id]).toEqual([USER, OTHER]);
  });

  describe('active guard: sendRequest/sendMessage/block/report не создают rows для deleted', () => {
    let service: PeerService;

    beforeEach(() => {
      service = new PeerService({
        query: (sql: string, params?: any[]) => pool.query(sql, params),
        getClient: () => pool.connect(),
      } as any);
    });

    it('sendRequest удалённого — BadRequest, chat_requests пуст', async () => {
      await expect(
        service.sendRequest(USER, { toUserId: OTHER, introMessage: 'hi' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await rows(`SELECT count(*)::int AS n FROM chat_requests`)).toEqual([{ n: 0 }]);
    });

    it('sendMessage удалённого — BadRequest, peer_messages пуст', async () => {
      await expect(
        service.sendMessage(USER, randomUUID(), { content: 'hi' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await rows(`SELECT count(*)::int AS n FROM peer_messages`)).toEqual([{ n: 0 }]);
    });

    it('block удалённого — BadRequest, user_blocks пуст', async () => {
      await expect(service.block(USER, OTHER)).rejects.toBeInstanceOf(BadRequestException);
      expect(await rows(`SELECT count(*)::int AS n FROM user_blocks`)).toEqual([{ n: 0 }]);
    });

    it('report удалённого — BadRequest, user_reports пуст', async () => {
      await expect(
        service.report(USER, { targetUserId: OTHER, reason: 'spam' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await rows(`SELECT count(*)::int AS n FROM user_reports`)).toEqual([{ n: 0 }]);
    });

    it('живой пользователь не блокируется гейтом', async () => {
      await expect(service.block(OTHER, USER)).resolves.toEqual({ ok: true });
      expect(await rows(`SELECT blocker_id,blocked_id FROM user_blocks`)).toEqual([
        { blocker_id: OTHER, blocked_id: USER },
      ]);
    });
  });
});
