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
  DeletionRetryError,
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

  // ==================== T17B-M5: частичный сбой и двойное удаление ====================

  /**
   * Снимок peer-таблиц без сгенерированных id и времени — по содержимому.
   * Порядок детерминирован сортировкой по всем выводимым колонкам, поэтому
   * два прогона над одинаковым посевом дают побайтно равные снимки.
   */
  async function peerSnapshot(): Promise<Record<string, any[]>> {
    return {
      conversations: await rows(
        `SELECT c.user_a_id, c.user_b_id,
                r.from_user_id AS req_from, r.to_user_id AS req_to
           FROM peer_conversations c LEFT JOIN chat_requests r ON r.id = c.request_id
          ORDER BY 1, 2`,
      ),
      messages: await rows(
        `SELECT c.user_a_id, c.user_b_id, m.sender_id, m.content
           FROM peer_messages m JOIN peer_conversations c ON c.id = m.conversation_id
          ORDER BY m.created_at, m.sender_id`,
      ),
      requests: await rows(
        `SELECT from_user_id, to_user_id, intro_message, status,
                responded_at IS NOT NULL AS responded
           FROM chat_requests ORDER BY 1, 2, 4, 3`,
      ),
      blocks: await rows(`SELECT blocker_id, blocked_id FROM user_blocks ORDER BY 1, 2`),
      reports: await rows(
        `SELECT reporter_id, target_id, reason, context_type, status, resolution
           FROM user_reports ORDER BY reason`,
      ),
    };
  }

  /** Строки снимка, в которых не участвует ни один из ids (чужая история). */
  function foreignOnly(snap: Record<string, any[]>, ids: string[]): Record<string, any[]> {
    const out: Record<string, any[]> = {};
    for (const [table, list] of Object.entries(snap)) {
      out[table] = list.filter((row) => !Object.values(row).some((v) => ids.includes(v as string)));
    }
    return out;
  }

  const THIRD_A = 'u-third-a';
  const THIRD_B = 'u-third-b';
  const OWN_CANARY = 'СВОЙ-ТЕКСТ-УДАЛЁННОГО';
  const DB_DOWN = Object.assign(new Error('connection terminated (spec)'), { code: '08006' });

  /**
   * Посев «всё сразу»: каждая из семи операций purge находит свою работу,
   * плюс чужая история третьих лиц, которой purge касаться не должен.
   */
  async function seedRichPeerHistory(): Promise<void> {
    const accepted = await seedRequest(OTHER, USER, 'их интро', 'accepted');
    const conv = await seedConversation(USER, OTHER);
    await pool.query(`UPDATE peer_conversations SET request_id=$1 WHERE id=$2`, [accepted, conv]);
    await seedMessage(conv, USER, OWN_CANARY, '2026-10-01T00:00:00Z');
    await seedMessage(conv, OTHER, 'ответ другого', '2026-10-01T00:01:00Z');
    await seedMessage(conv, USER, `${OWN_CANARY}-2`, '2026-10-01T00:02:00Z');
    const low = await seedConversation(USER, 'a-user');
    await seedMessage(low, 'a-user', 'a-user пишет', '2026-10-02T00:00:00Z');
    const foreign = await seedConversation(THIRD_A, THIRD_B);
    await seedMessage(foreign, THIRD_A, 'чужая переписка', '2026-10-03T00:00:00Z');
    await seedMessage(foreign, THIRD_B, 'чужой ответ', '2026-10-03T00:01:00Z');

    await seedRequest(USER, OTHER, OWN_CANARY, 'withdrawn');
    await seedRequest(THIRD_A, USER, 'входящая от третьего');
    await seedRequest(THIRD_A, THIRD_B, 'чужая заявка');

    await pool.query(
      `INSERT INTO user_blocks (blocker_id,blocked_id)
       VALUES ($1,'u-victim'), ('u-blocker',$1), ($2,$3)`,
      [USER, THIRD_A, THIRD_B],
    );
    await pool.query(
      `INSERT INTO user_reports (reporter_id,target_id,reason,context_type,status,resolution)
       VALUES ($1,'u-reported','r1 моя жалоба','conversation','new',NULL),
              ('u-reporter2',$1,'r2 жалоба на меня',NULL,'resolved','warned'),
              ($2,$3,'r3 чужая жалоба',NULL,'new',NULL)`,
      [USER, THIRD_A, THIRD_B],
    );
  }

  /**
   * ctx, чей db роняет N-й запрос. 'before' — запрос не исполнен (обрыв до
   * отправки); 'after' — запрос исполнен и закоммичен (autocommit, раннер
   * отдаёт адаптеру pool без транзакции), но ответ потерян.
   */
  function failingCtx(failAt: number, mode: 'before' | 'after') {
    let n = 0;
    const executed: string[] = [];
    const ctx: DeletionExecution = {
      db: {
        query: async (sql: string, params?: unknown[]) => {
          n += 1;
          if (n === failAt && mode === 'before') throw DB_DOWN;
          const result = await pool.query(sql, params as any[]);
          executed.push(sql.replace(/\s+/g, ' ').trim().slice(0, 40));
          if (n === failAt && mode === 'after') throw DB_DOWN;
          return result;
        },
      },
      assertCurrent: jest.fn(async () => undefined),
    };
    return { ctx, executed: () => executed, calls: () => n };
  }

  async function cleanPurgeSnapshot(): Promise<Record<string, any[]>> {
    await pool.query(
      `TRUNCATE peer_messages, peer_conversations, chat_requests, user_blocks, user_reports`,
    );
    await seedRichPeerHistory();
    await adapter.execute(jobRow('peer.purge'), makeCtx());
    return peerSnapshot();
  }

  // purge — семь statement'ов (messages, redact, requests, conversations,
  // blocks out, blocks in, reports); роняем каждый в обоих режимах.
  const PURGE_STATEMENTS = 7;
  const failurePoints = Array.from({ length: PURGE_STATEMENTS }, (_, i) => i + 1)
    .flatMap((failAt) => (['before', 'after'] as const).map((mode) => ({ failAt, mode })));

  it.each(failurePoints)(
    'частичный сбой purge на запросе $failAt ($mode): retry сходится к итогу чистого прогона без дублей',
    async ({ failAt, mode }) => {
      await seedRichPeerHistory();
      const before = await peerSnapshot();
      const failing = failingCtx(failAt, mode);

      const error = await adapter.execute(jobRow('peer.purge'), failing.ctx).catch((e) => e);

      // Сбой не проглочен и классифицирован как retryable db-ошибка.
      expect(error).toBeInstanceOf(DeletionRetryError);
      expect(error.kind).toBe('db');
      // Purge остановился на упавшем запросе, следующие не исполнялись.
      expect(failing.calls()).toBe(failAt);
      expect(failing.executed()).toHaveLength(mode === 'after' ? failAt : failAt - 1);

      // Повтор задачи (воркер подхватит failed-строку) — штатный ctx.
      await expect(adapter.execute(jobRow('peer.purge'), makeCtx())).resolves.toBeUndefined();
      const afterRetry = await peerSnapshot();

      // Чужая история третьих лиц не тронута ни сбоем, ни повтором.
      expect(foreignOnly(afterRetry, [USER, ALIAS])).toEqual(foreignOnly(before, [USER, ALIAS]));
      // Без дублей и без потерь чужих строк: число разговоров/заявок/жалоб то же,
      // сообщений меньше ровно на свои два, блокировок — на одну исходящую.
      expect(afterRetry.conversations).toHaveLength(before.conversations.length);
      expect(afterRetry.requests).toHaveLength(before.requests.length);
      expect(afterRetry.reports).toHaveLength(before.reports.length);
      expect(afterRetry.messages).toHaveLength(before.messages.length - 2);
      expect(afterRetry.blocks).toHaveLength(before.blocks.length - 1);
      const dump = JSON.stringify(afterRetry);
      expect(dump).not.toContain(`"${USER}"`);
      expect(dump).not.toContain(OWN_CANARY);
      expect(dump).toContain(ALIAS);

      // Итог совпадает с чистым (безотказным) прогоном над тем же посевом.
      expect(afterRetry).toEqual(await cleanPurgeSnapshot());
    },
  );

  describe('оба партнёра переписки удалены (alias поверх alias)', () => {
    const PARTNER = 'u-partner';
    const THIRD = 'u-third';
    const PARTNER_DELETION = '2b6f0c1d-8e4a-4f3b-9c2d-7a1e5b9f0c3d';
    const PARTNER_ALIAS = `deleted:${PARTNER_DELETION}`;
    const A_CANARY = 'ТЕКСТ-ПЕРВОГО-УДАЛЁННОГО';
    const B_CANARY = 'ТЕКСТ-ВТОРОГО-УДАЛЁННОГО';

    function partnerJob(resourceType: 'peer.stop' | 'peer.purge'): DeletionJobRow {
      return jobRow(resourceType, {
        id: `job-partner-${resourceType}`,
        userId: PARTNER,
        deletionId: PARTNER_DELETION,
      });
    }

    async function seedPair(): Promise<void> {
      await seedUser(PARTNER, 'deleted', PARTNER_DELETION);
      await seedUser(THIRD, 'active');

      const accepted = await seedRequest(PARTNER, USER, B_CANARY, 'accepted');
      const pair = await seedConversation(USER, PARTNER);
      await pool.query(`UPDATE peer_conversations SET request_id=$1 WHERE id=$2`, [accepted, pair]);
      await seedMessage(pair, USER, A_CANARY, '2026-10-01T00:00:00Z');
      await seedMessage(pair, PARTNER, B_CANARY, '2026-10-01T00:01:00Z');
      const withThirdB = await seedConversation(PARTNER, THIRD);
      await seedMessage(withThirdB, PARTNER, `${B_CANARY}-2`, '2026-10-02T00:00:00Z');
      await seedMessage(withThirdB, THIRD, 'третий пишет второму', '2026-10-02T00:01:00Z');
      const withThirdA = await seedConversation(USER, THIRD);
      await seedMessage(withThirdA, THIRD, 'третий пишет первому', '2026-10-03T00:00:00Z');

      await seedRequest(USER, PARTNER, A_CANARY, 'withdrawn');
      await seedRequest(THIRD, PARTNER, 'третий зовёт второго');
      await seedRequest(PARTNER, THIRD, `${B_CANARY}-3`);

      await pool.query(
        `INSERT INTO user_blocks (blocker_id,blocked_id)
         VALUES ($1,$2), ($2,$1), ($3,$1), ($3,$2)`,
        [USER, PARTNER, THIRD],
      );
      await pool.query(
        `INSERT INTO user_reports (reporter_id,target_id,reason,status)
         VALUES ($1,$2,'r1 первый на второго','new'),
                ($2,$1,'r2 второй на первого','new'),
                ($3,$2,'r3 третий на второго','new')`,
        [USER, PARTNER, THIRD],
      );
    }

    async function deleteBoth(order: 'first-then-partner' | 'partner-then-first'): Promise<void> {
      const first = async () => {
        await adapter.execute(jobRow('peer.stop'), makeCtx());
        await adapter.execute(jobRow('peer.purge'), makeCtx());
      };
      const partner = async () => {
        await adapter.execute(partnerJob('peer.stop'), makeCtx());
        await adapter.execute(partnerJob('peer.purge'), makeCtx());
      };
      if (order === 'first-then-partner') {
        await first();
        await partner();
      } else {
        await partner();
        await first();
      }
    }

    it.each(['first-then-partner', 'partner-then-first'] as const)(
      'история второго обезличена поверх alias первого, данные третьего целы (%s)',
      async (order) => {
        await seedPair();

        await deleteBoth(order);
        const snap = await peerSnapshot();

        const [lo, hi] = [ALIAS, PARTNER_ALIAS].sort();
        // Разговор пары остался оболочкой из двух alias (CHECK a<b и UNIQUE
        // держатся), ссылка на заявку цела; сообщений обоих удалённых нет.
        expect(snap.conversations).toEqual(expect.arrayContaining([
          { user_a_id: lo, user_b_id: hi, req_from: PARTNER_ALIAS, req_to: ALIAS },
          { user_a_id: ALIAS, user_b_id: THIRD, req_from: null, req_to: null },
          { user_a_id: PARTNER_ALIAS, user_b_id: THIRD, req_from: null, req_to: null },
        ]));
        expect(snap.conversations).toHaveLength(3);
        // Остаются только сообщения третьего — в разговорах с alias обоих.
        expect(snap.messages).toEqual([
          { user_a_id: PARTNER_ALIAS, user_b_id: THIRD, sender_id: THIRD, content: 'третий пишет второму' },
          { user_a_id: ALIAS, user_b_id: THIRD, sender_id: THIRD, content: 'третий пишет первому' },
        ]);
        // Заявки: intro обоих удалённых стёрты, заявка третьего сохранила текст;
        // исходящая pending второго отозвана его stop'ом.
        expect(snap.requests).toEqual(expect.arrayContaining([
          { from_user_id: ALIAS, to_user_id: PARTNER_ALIAS, intro_message: '', status: 'withdrawn', responded: false },
          { from_user_id: PARTNER_ALIAS, to_user_id: ALIAS, intro_message: '', status: 'accepted', responded: false },
          { from_user_id: PARTNER_ALIAS, to_user_id: THIRD, intro_message: '', status: 'withdrawn', responded: true },
          { from_user_id: THIRD, to_user_id: PARTNER_ALIAS, intro_message: 'третий зовёт второго', status: 'pending', responded: false },
        ]));
        expect(snap.requests).toHaveLength(4);
        // Блокировки: взаимные исходящие удалённых сняты, блокировки третьего —
        // на alias каждого.
        expect(snap.blocks).toEqual(
          [
            { blocker_id: THIRD, blocked_id: ALIAS },
            { blocker_id: THIRD, blocked_id: PARTNER_ALIAS },
          ].sort((x, y) => (x.blocked_id < y.blocked_id ? -1 : 1)),
        );
        // Жалобы: обе стороны — alias, reason (доказательство модерации) цел.
        expect(snap.reports).toEqual([
          { reporter_id: ALIAS, target_id: PARTNER_ALIAS, reason: 'r1 первый на второго', context_type: null, status: 'new', resolution: null },
          { reporter_id: PARTNER_ALIAS, target_id: ALIAS, reason: 'r2 второй на первого', context_type: null, status: 'new', resolution: null },
          { reporter_id: THIRD, target_id: PARTNER_ALIAS, reason: 'r3 третий на второго', context_type: null, status: 'new', resolution: null },
        ]);
        const dump = JSON.stringify(snap);
        for (const leaked of [`"${USER}"`, `"${PARTNER}"`, A_CANARY, B_CANARY]) {
          expect(dump).not.toContain(leaked);
        }
        // Профильные строки не переименовываются (alias только в peer-таблицах).
        expect(await rows(`SELECT internal_id FROM user_id ORDER BY 1`)).toEqual(
          [OTHER, PARTNER, USER, THIRD].sort().map((internal_id) => ({ internal_id })),
        );
      },
    );

    it('итог не зависит от порядка удаления партнёров; повтор обоих purge — no-op', async () => {
      await seedPair();
      await deleteBoth('first-then-partner');
      const forward = await peerSnapshot();

      await pool.query(
        `TRUNCATE peer_messages, peer_conversations, chat_requests, user_blocks, user_reports`,
      );
      await pool.query(`DELETE FROM user_id WHERE internal_id IN ($1,$2)`, [PARTNER, THIRD]);
      await seedPair();
      await deleteBoth('partner-then-first');
      const backward = await peerSnapshot();

      expect(backward).toEqual(forward);

      await adapter.execute(jobRow('peer.purge'), makeCtx());
      await adapter.execute(partnerJob('peer.purge'), makeCtx());
      expect(await peerSnapshot()).toEqual(backward);
    });
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
