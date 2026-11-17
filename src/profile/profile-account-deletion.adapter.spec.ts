import { AccountDeletionPlanner } from '../account-deletion/account-deletion.planner';
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
import {
  deleteOwnedCoreRows,
  ProfileAccountDeletionAdapter,
} from './profile-account-deletion.adapter';
import { ProfileAccountDeletionRecapture } from './profile-account-deletion.discovery';

/**
 * Task 17 (unit) — порядок execute, fencing-исходы и форма SQL.
 *
 * Фейки строгие: незнакомый SQL бросает (прецедент legacy-smm pg spec),
 * поэтому пропуск или перестановка шага ломает тест, а не проходит молча.
 * Живая БД — в profile-account-deletion.pg.spec.ts.
 */

const USER = 'u-deleted';
const DELETION_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const DELETED_AT = new Date('2026-11-01T00:00:00.000Z');
const BUCKET = 'linkeon-chat-files';
const FILE_KEY = 'late/file.pdf';
const FILE_URL = `https://minio.test/${BUCKET}/${FILE_KEY}`;
const PERSONAL_CANARY = 'ЛИЧНЫЙ-ТЕКСТ';
const TEST_ENV: ExtractEnv = {
  publicBaseUrl: 'https://minio.test',
  agentUrl: 'https://agent.test',
  backendUrl: 'https://backend.test',
};

function coreJob(overrides: Partial<DeletionJobRow> = {}): DeletionJobRow {
  return {
    id: 'job-core',
    deletionId: DELETION_ID,
    userId: USER,
    resourceType: 'account.core.immediate',
    resourceKey: 'account',
    phase: 'immediate',
    payload: {},
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date('2026-11-14T00:00:00Z'),
    leaseUntil: new Date('2099-01-01T00:00:00Z'),
    lastErrorKind: null,
    ...overrides,
  };
}

function norm(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** Метки семи выражений deleteOwnedCoreRows — порядок фиксирует план. */
const DELETE_MARKERS: Array<[RegExp, string]> = [
  [/^DELETE FROM custom_chat_history/, 'delete:history'],
  [/^DELETE FROM action_plans/, 'delete:plans'],
  [/^DELETE FROM chat_context_resets/, 'delete:context-resets'],
  [/^UPDATE ai_profiles_consolidated SET profile_data = '\{\}'/, 'clear:profile'],
  [/^DELETE FROM user_identities/, 'delete:identities'],
  [/^DELETE FROM tg_user_identities/, 'delete:tg'],
  [/^UPDATE user_id SET password_hash = NULL/, 'tombstone:user_id'],
];

function makeOrderFakes() {
  const log: string[] = [];
  const txQueries: Array<{ sql: string; params: any[] }> = [];
  const txClient = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      const s = norm(sql);
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') {
        log.push(s);
        return { rows: [], rowCount: 0 };
      }
      const marker = DELETE_MARKERS.find(([re]) => re.test(s));
      if (!marker) throw new Error(`unexpected tx query: ${s}`);
      log.push(marker[1]);
      txQueries.push({ sql: s, params });
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn(() => { log.push('release'); }),
  };
  const pg = {
    query: jest.fn(async (sql: string) => {
      throw new Error(`unexpected pool query: ${norm(sql)}`);
    }),
    getClient: jest.fn(async () => { log.push('getClient'); return txClient; }),
  };
  const jobs = {
    assertNoImmediateBlockers: jest.fn(async () => { log.push('blockers'); }),
    lockAndAssertCurrent: jest.fn(async () => { log.push('lock'); }),
  };
  const recapture = {
    collectAndPersist: jest.fn(async () => { log.push('recapture'); }),
  };
  const neo4j = {
    deleteUserGraphStrict: jest.fn(async () => { log.push('graph'); }),
  };
  const registry = { register: jest.fn() };
  const adapter = new ProfileAccountDeletionAdapter(
    pg as any, jobs as any, recapture as any, neo4j as any, registry as any,
  );
  const ctx: DeletionExecution & { assertCurrent: jest.Mock } = {
    db: pg as any,
    assertCurrent: jest.fn(async () => { log.push('assertCurrent'); }),
  };
  return { log, txQueries, txClient, pg, jobs, recapture, neo4j, registry, adapter, ctx };
}

let origBucketEnv: string | undefined;

beforeAll(() => {
  origBucketEnv = process.env.MINIO_BUCKET_CHAT_FILES;
  process.env.MINIO_BUCKET_CHAT_FILES = BUCKET;
});

afterAll(() => {
  if (origBucketEnv === undefined) delete process.env.MINIO_BUCKET_CHAT_FILES;
  else process.env.MINIO_BUCKET_CHAT_FILES = origBucketEnv;
});

describe('ProfileAccountDeletionAdapter.execute — порядок и fencing (Task 17)', () => {
  it('порядок шагов: fences → recapture → blockers → graph → одна tx (lock + 7 fenced-выражений)', async () => {
    const f = makeOrderFakes();

    await f.adapter.execute(coreJob(), f.ctx);

    expect(f.log).toEqual([
      'assertCurrent', 'recapture', 'blockers', 'assertCurrent',
      'graph', 'assertCurrent',
      'getClient', 'BEGIN', 'lock',
      'delete:history', 'delete:plans', 'delete:context-resets', 'clear:profile',
      'delete:identities', 'delete:tg', 'tombstone:user_id',
      'COMMIT', 'release',
    ]);
    expect(f.jobs.lockAndAssertCurrent).toHaveBeenCalledWith(f.txClient, coreJob());
    // Каждое DELETE/UPDATE fenced поколением удаления и параметризовано
    // [userId, deletionId] — никаких литералов пользователя в SQL.
    for (const q of f.txQueries) {
      expect(q.params).toEqual([USER, DELETION_ID]);
    }
    // Все, кроме tombstone: у него своё условие на поколение (проверено ниже).
    for (const q of f.txQueries.slice(0, -1)) {
      expect(q.sql).toContain(
        `EXISTS (SELECT 1 FROM user_id WHERE internal_id = $1 AND state = 'deleted' AND deletion_id = $2)`,
      );
    }
    // История — по escaped session prefix: `_` в шаблоне обязан быть экранирован.
    expect(f.txQueries[0].sql).toContain(String.raw`session_id LIKE $1 || '\_%' ESCAPE '\'`);
    // Точки «Чистого листа» — по точному user_id, без шаблонов.
    const resets = f.txQueries.find((q) => q.sql.startsWith('DELETE FROM chat_context_resets'));
    expect(resets?.sql).toContain('WHERE user_id = $1 AND');
  });

  it('чужой resourceType — отказ до любого шага', async () => {
    const f = makeOrderFakes();

    await expect(
      f.adapter.execute(coreJob({ resourceType: 'avatar.purge' }), f.ctx),
    ).rejects.toThrow('unsupported_deletion_resource');

    expect(f.ctx.assertCurrent).not.toHaveBeenCalled();
    expect(f.recapture.collectAndPersist).not.toHaveBeenCalled();
    expect(f.neo4j.deleteUserGraphStrict).not.toHaveBeenCalled();
    expect(f.pg.getClient).not.toHaveBeenCalled();
    expect(f.log).toEqual([]);
  });

  it('reactivation после graph — cancelled, транзакция не начинается', async () => {
    const f = makeOrderFakes();
    f.ctx.assertCurrent
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new DeletionCancelledError());

    await expect(f.adapter.execute(coreJob(), f.ctx))
      .rejects.toBeInstanceOf(DeletionCancelledError);

    expect(f.neo4j.deleteUserGraphStrict).toHaveBeenCalledWith(USER);
    expect(f.pg.getClient).not.toHaveBeenCalled();
    expect(f.log).not.toContain('BEGIN');
  });

  it('lockAndAssertCurrent не нашёл поколение — cancelled, ROLLBACK, ни одного DELETE', async () => {
    const f = makeOrderFakes();
    f.jobs.lockAndAssertCurrent.mockRejectedValue(new DeletionCancelledError());

    await expect(f.adapter.execute(coreJob(), f.ctx))
      .rejects.toBeInstanceOf(DeletionCancelledError);

    expect(f.log).toEqual(expect.arrayContaining(['BEGIN', 'ROLLBACK', 'release']));
    for (const [, label] of DELETE_MARKERS) expect(f.log).not.toContain(label);
  });

  it('ошибка graph — retryable с классификацией: ETIMEDOUT → timeout, прочее → external_unknown', async () => {
    const timeout = makeOrderFakes();
    timeout.neo4j.deleteUserGraphStrict.mockRejectedValue(
      Object.assign(new Error('connection timed out'), { code: 'ETIMEDOUT' }),
    );
    const tErr = await timeout.adapter.execute(coreJob(), timeout.ctx).catch((e) => e);
    expect(tErr).toBeInstanceOf(DeletionRetryError);
    expect(tErr).toMatchObject({ kind: 'timeout' });
    expect(timeout.pg.getClient).not.toHaveBeenCalled();

    const unknown = makeOrderFakes();
    unknown.neo4j.deleteUserGraphStrict.mockRejectedValue(new Error('driver is closed'));
    const uErr = await unknown.adapter.execute(coreJob(), unknown.ctx).catch((e) => e);
    expect(uErr).toBeInstanceOf(DeletionRetryError);
    expect(uErr).toMatchObject({ kind: 'external_unknown' });
    expect(unknown.pg.getClient).not.toHaveBeenCalled();
  });

  it('cancelled из graph пробрасывается как есть, не превращаясь в retry', async () => {
    const f = makeOrderFakes();
    const cancelled = new DeletionCancelledError();
    f.neo4j.deleteUserGraphStrict.mockRejectedValue(cancelled);

    const err = await f.adapter.execute(coreJob(), f.ctx).catch((e) => e);

    expect(err).toBe(cancelled);
    expect(f.pg.getClient).not.toHaveBeenCalled();
  });

  it('незавершённые stop-задачи — retryable kind db, graph не вызывается', async () => {
    const f = makeOrderFakes();
    f.jobs.assertNoImmediateBlockers.mockRejectedValue(new DeletionRetryError('db'));

    const err = await f.adapter.execute(coreJob(), f.ctx).catch((e) => e);

    expect(err).toBeInstanceOf(DeletionRetryError);
    expect(err).toMatchObject({ kind: 'db' });
    expect(f.neo4j.deleteUserGraphStrict).not.toHaveBeenCalled();
    expect(f.ctx.assertCurrent).toHaveBeenCalledTimes(1);
    expect(f.pg.getClient).not.toHaveBeenCalled();
  });
});

describe('deleteOwnedCoreRows — форма SQL (Task 17)', () => {
  it('tombstone не трогает state/deleted_at/deletion_id/welcome_bonus_at — только password/email/contacts/update_date', async () => {
    const calls: Array<{ sql: string; params: any[] }> = [];
    const tx = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        calls.push({ sql: norm(sql), params });
        return { rows: [], rowCount: 0 };
      }),
    };

    await deleteOwnedCoreRows(tx, coreJob());

    expect(calls).toHaveLength(7);
    const tombstone = calls[6];
    expect(tombstone.sql).toMatch(/^UPDATE user_id SET password_hash = NULL/);
    const [setClause, whereClause] = tombstone.sql.split(' WHERE ');
    expect(whereClause).toBeDefined();
    // Поколение (state/deletion_id) принадлежит begin()/reactivation, а не
    // core finalize: SET-часть не должна их переписывать.
    expect(setClause).not.toMatch(/\bstate\b|\bdeleted_at\b|\bdeletion_id\b/);
    expect(setClause).toContain('primary_email = NULL');
    // T17-M6: contacts — мёртвая колонка, но план :1492 требует очистки.
    expect(setClause).toContain('contacts = NULL');
    // T20-M1: отметка приветственного бонуса переживает удаление — бонус один
    // раз на аккаунт за всё время, телефонный вход реактивирует ту же строку.
    expect(setClause).not.toContain('welcome_bonus_at');
    expect(setClause).toContain('update_date = now()');
    expect(whereClause).toContain(`internal_id = $1 AND state = 'deleted' AND deletion_id = $2`);
    for (const c of calls) expect(c.params).toEqual([USER, DELETION_ID]);
  });
});

describe('ProfileAccountDeletionRecapture.collectAndPersist (Task 17)', () => {
  class RecaptureFakeDb {
    readonly inserts: Array<{ sql: string; params: any[] }> = [];
    readonly queries: Array<{ sql: string; params: any[] }> = [];
    readonly txLog: string[] = [];
    genOk = true;
    historyPages: any[][] = [[{ id: 1, content: `[file](${FILE_URL}) ${PERSONAL_CANARY}` }], []];
    private historyCalls = 0;

    async query(sql: string, params: any[] = []) {
      const s = norm(sql);
      this.queries.push({ sql: s, params });
      if (s.startsWith('SELECT deleted_at FROM user_id')) {
        return this.genOk
          ? { rows: [{ deleted_at: DELETED_AT }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (s.startsWith('SELECT h.id, h.content FROM custom_chat_history')) {
        const page = this.historyPages[this.historyCalls] ?? [];
        this.historyCalls += 1;
        return { rows: page, rowCount: page.length };
      }
      throw new Error(`unexpected query: ${s}`);
    }

    async getClient() {
      const self = this;
      return {
        async query(sql: string, params: any[] = []) {
          const s = norm(sql);
          if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') {
            self.txLog.push(s);
            return { rows: [], rowCount: 0 };
          }
          if (s.startsWith('INSERT INTO account_deletion_jobs')) {
            self.inserts.push({ sql: s, params });
            return { rows: [], rowCount: 1 };
          }
          throw new Error(`unexpected tx query: ${s}`);
        },
        release: () => undefined,
      };
    }
  }

  function makeRecapture(fake: RecaptureFakeDb) {
    return new ProfileAccountDeletionRecapture(
      fake as any,
      new AccountDeletionPlanner([]),
      TEST_ENV,
    );
  }

  it('поздний file persistится отдельной короткой tx в форме planner.persist', async () => {
    const fake = new RecaptureFakeDb();

    await makeRecapture(fake).collectAndPersist(coreJob());

    // Fenced-чтение поколения: params [userId, deletionId].
    const gen = fake.queries.find((q) => q.sql.startsWith('SELECT deleted_at FROM user_id'));
    expect(gen?.params).toEqual([USER, DELETION_ID]);
    expect(fake.txLog).toEqual(['BEGIN', 'COMMIT']);
    expect(fake.inserts).toHaveLength(1);
    const params = fake.inserts[0].params;
    expect(params[0]).toBe(DELETION_ID);
    expect(params[1]).toBe(USER);
    expect(params[2]).toBe('chat-file.purge');
    expect(params[3]).toBe(deletionResourceHash(BUCKET, FILE_KEY));
    expect(params[4]).toBe('purge');
    // payload — только MinIO locator, key в base64url (сырой ключ роняет
    // fail-closed sanitizer); никакого личного текста и userId.
    expect(JSON.parse(params[5] as string)).toEqual({
      bucket: BUCKET,
      key: Buffer.from(FILE_KEY, 'utf8').toString('base64url'),
    });
    expect(params[5]).not.toContain(PERSONAL_CANARY);
    expect(params[5]).not.toContain(USER);
    // Purge откладывается на retention от deleted_at.
    expect((params[6] as Date).getTime())
      .toBe(DELETED_AT.getTime() + ACCOUNT_DELETION_RETENTION_MS);
    // ON CONFLICT-дедупликация — в тексте INSERT (дословный текст
    // planner.persist: framework-файл, его SQL неизменяем).
    expect(fake.inserts[0].sql)
      .toContain('ON CONFLICT (deletion_id,resource_type,resource_key) DO NOTHING');
  });

  it('поколение не совпало — cancelled без единой записи', async () => {
    const fake = new RecaptureFakeDb();
    fake.genOk = false;

    await expect(makeRecapture(fake).collectAndPersist(coreJob()))
      .rejects.toBeInstanceOf(DeletionCancelledError);

    expect(fake.inserts).toEqual([]);
    expect(fake.txLog).toEqual([]);
  });

  it('файлов нет — транзакция не открывается', async () => {
    const fake = new RecaptureFakeDb();
    fake.historyPages = [[]];

    await makeRecapture(fake).collectAndPersist(coreJob());

    expect(fake.inserts).toEqual([]);
    expect(fake.txLog).toEqual([]);
  });
});
