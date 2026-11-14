import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
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
import { canReceiveNewProposal } from '../privacy/profile-privacy';
import { ContactsModule } from './contacts.module';
import { ContactsService } from './contacts.service';
import {
  discoverContactsDeletion,
  ContactsAccountDeletionAdapter,
} from './contacts-account-deletion.adapter';

jest.mock('../privacy/profile-privacy', () => ({
  canReceiveNewProposal: jest.fn(),
  readProfileAccess: jest.fn(),
  readProfileAccessBatch: jest.fn(),
}));

const canReceive = canReceiveNewProposal as jest.MockedFunction<typeof canReceiveNewProposal>;

/**
 * Task 17B — contacts: redact вместо удаления shared history.
 *
 * contact_requests хранит СОБСТВЕННЫЕ surrogate id (requester_id/target_id →
 * ai_profiles_consolidated.id, INTEGER без FK). Purge:
 *  - находит surrogate id удалённого поколения (generation predicate);
 *  - очищает message у requests, где requester_id = этот surrogate (текст
 *    удалённого — его данные; сама строка — shared history второго
 *    участника и сохраняется, status/joins не трогаются);
 *  - profile shell (ai_profiles_consolidated) НЕ удаляется и surrogate id НЕ
 *    переименовывается — phoneById/idByPhone и listIncoming/listOutgoing
 *    продолжают работать.
 * Чужие requests (в адрес удалённого и между третьими) сохраняются полностью
 * (canary-тест из плана).
 */

const USER = 'u-deleted';
const OTHER = 'u-other';
const THIRD = 'u-third';
const SURROGATE = 11;
const OTHER_ID = 22;
const THIRD_ID = 33;
const OWN_CANARY = 'ЛИЧНЫЙ-ТЕКСТ';
const OTHER_CANARY = 'other note';
const deletionId = '5c4b3a29-1d0e-4f6a-8b7c-9d0e1f2a3b4c';
const account: DeletionAccount = {
  userId: USER,
  deletionId,
  deletedAt: new Date('2026-11-01T00:00:00.000Z'),
};

interface RequestRow {
  id: number;
  requester_id: number;
  target_id: number;
  message: string | null;
  status: string;
}

/**
 * Фейковая БД: повторяет SQL-семантику адаптера (generation gate, scoped
 * UPDATE под predicate) и active-гейта createRequest. Неизвестный запрос —
 * throw. Журнал queries хранит порядок операций.
 */
class FakeContactsDb {
  readonly users = new Map<string, { state: string; deletionId: string | null }>();
  readonly profiles: Array<{ id: number; user_id: string }> = [];
  requests: RequestRow[] = [];
  readonly queries: Array<{ sql: string; params: any[] }> = [];
  /** Отказ UPDATE — проверка обёртки DeletionRetryError. */
  failUpdate = false;
  private nextId = 1;

  async query(sql: string, params: any[] = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    this.queries.push({ sql: s, params });

    // Generation gate адаптера: state='deleted' + точное поколение.
    if (s.startsWith('SELECT 1 FROM user_id') && s.includes(`'deleted'`)) {
      const [userId, genId] = params as [string, string];
      const ok = this.isCurrentDeletion(String(userId), String(genId));
      return ok ? { rows: [{ n: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    // Active-гейт сервисов: state='active' (без поколения).
    if (s.startsWith('SELECT 1 FROM user_id') && s.includes(`'active'`)) {
      const [userId] = params as [string];
      const ok = this.users.get(String(userId))?.state === 'active';
      return ok ? { rows: [{ n: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    // Surrogate lookup: idByPhone сервисов и SELECT адаптера (у адаптера
    // в SQL есть EXISTS-гейт поколения — повторяем его семантику).
    if (s.startsWith('SELECT id FROM ai_profiles_consolidated WHERE user_id')) {
      if (s.includes('EXISTS') && !this.isCurrentDeletion(String(params[0]), String(params[1]))) {
        return { rows: [], rowCount: 0 };
      }
      const profile = this.profiles.find((p) => p.user_id === String(params[0]));
      return profile
        ? { rows: [{ id: profile.id }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('SELECT user_id FROM ai_profiles_consolidated WHERE id')) {
      const profile = this.profiles.find((p) => p.id === Number(params[0]));
      return profile
        ? { rows: [{ user_id: profile.user_id }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('UPDATE contact_requests SET message=NULL')) {
      if (this.failUpdate) {
        // SQLSTATE 08006 (connection_failure) → deletionErrorKind = 'db'.
        throw Object.assign(new Error('connection terminated'), { code: '08006' });
      }
      const [requesterId, userId, genId] = params as [number, string, string];
      // EXISTS-гейт: поколение не совпало → 0 строк (идемпотентный успех).
      if (!this.isCurrentDeletion(String(userId), String(genId))) {
        return { rows: [], rowCount: 0 };
      }
      let n = 0;
      for (const row of this.requests) {
        if (row.requester_id === Number(requesterId)) {
          row.message = null;
          n++;
        }
      }
      return { rows: [], rowCount: n };
    }
    if (s.startsWith('INSERT INTO contact_requests')) {
      throw new Error('createRequest не должен доходить до INSERT для deleted');
    }
    throw new Error(`unexpected query: ${s}`);
  }

  isCurrentDeletion(userId: string, genId: string): boolean {
    const u = this.users.get(userId);
    return u?.state === 'deleted' && u.deletionId === genId;
  }

  seedDefault() {
    this.users.set(USER, { state: 'deleted', deletionId });
    this.users.set(OTHER, { state: 'active', deletionId: null });
    this.profiles.push(
      { id: SURROGATE, user_id: USER },
      { id: OTHER_ID, user_id: OTHER },
      { id: THIRD_ID, user_id: THIRD },
    );
    this.requests.push(
      { id: this.nextId++, requester_id: SURROGATE, target_id: OTHER_ID, message: OWN_CANARY, status: 'pending' },
      { id: this.nextId++, requester_id: OTHER_ID, target_id: SURROGATE, message: OTHER_CANARY, status: 'approved' },
      { id: this.nextId++, requester_id: OTHER_ID, target_id: THIRD_ID, message: 'third note', status: 'pending' },
    );
  }
}

function makeHarness() {
  const db = new FakeContactsDb();
  db.seedDefault();
  const registry = new AccountDeletionRegistry();
  const adapter = new ContactsAccountDeletionAdapter(registry);
  const assertCurrent = jest.fn(async () => undefined);
  const ctx: DeletionExecution & { assertCurrent: jest.Mock } = { db, assertCurrent };
  return { db, registry, adapter, ctx };
}

function purgeJob(overrides: Partial<DeletionJobRow> = {}): DeletionJobRow {
  return {
    id: 'job-contacts-1',
    deletionId,
    userId: USER,
    resourceType: 'contacts.purge',
    resourceKey: 'contacts',
    phase: 'purge',
    payload: {},
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date('2026-12-14T00:00:00Z'),
    leaseUntil: new Date('2026-12-14T01:00:00Z'),
    lastErrorKind: null,
    ...overrides,
  };
}

describe('discoverContactsDeletion — один пустой job на аккаунт (Task 17B)', () => {
  it('payload {}, resourceKey без userId; sanitizer плана проходит', async () => {
    const { db } = makeHarness();

    const plan = await discoverContactsDeletion({ db, account, origin: 'explicit' });

    expect(plan.jobs).toEqual([{
      resourceType: 'contacts.purge',
      resourceKey: 'contacts',
      phase: 'purge',
      payload: {},
    }]);
    expect(plan.skips).toEqual([]);
    const json = JSON.stringify(plan.jobs);
    expect(json).not.toContain(USER);
    expect(json).not.toContain(OWN_CANARY);
    expect(() => safeDeletionJobSnapshot(plan.jobs[0], USER)).not.toThrow();
    // Discovery НЕ читает contact_requests/ai_profiles_consolidated — только
    // generation gate (message в план не поднимается).
    expect(db.queries.every((q) => q.sql.startsWith('SELECT 1 FROM user_id'))).toBe(true);
  });

  it('reactivation (поколение не совпало) — план пустой', async () => {
    const { db } = makeHarness();
    db.users.set(USER, { state: 'active', deletionId: null });

    const plan = await discoverContactsDeletion({ db, account, origin: 'explicit' });

    expect(plan).toEqual({ jobs: [], skips: [] });
  });
});

describe('ContactsAccountDeletionAdapter.execute — redact своих contact requests (Task 17B)', () => {
  it('очищает message только своего requester, строки и чужие message сохраняет', async () => {
    const { db, adapter, ctx } = makeHarness();

    await adapter.execute(purgeJob(), ctx);

    // Все три строки на месте (shared history не удаляется).
    expect(db.requests).toHaveLength(3);
    // Свой request: message → NULL, status/join не тронуты.
    expect(db.requests[0]).toMatchObject({
      requester_id: SURROGATE, target_id: OTHER_ID, message: null, status: 'pending',
    });
    // Чужой request в адрес удалённого остаётся (canary-тест плана).
    expect(db.requests[1]).toMatchObject({
      requester_id: OTHER_ID, target_id: SURROGATE, message: OTHER_CANARY, status: 'approved',
    });
    // Чужой request между третьими не тронут.
    expect(db.requests[2]).toMatchObject({ requester_id: OTHER_ID, target_id: THIRD_ID, message: 'third note' });
    // Profile shell не удаляется — joins не рвутся.
    expect(db.profiles).toEqual(expect.arrayContaining([{ id: SURROGATE, user_id: USER }]));
    expect(ctx.assertCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'contacts.purge' }),
    );
    // Canary: собственный текст не ушёл ни в один SQL-параметр после redact.
    expect(JSON.stringify(db.queries)).not.toContain(OWN_CANARY);
  });

  it('нет profile shell — тихий успех без UPDATE', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.profiles.length = 0;

    await expect(adapter.execute(purgeJob(), ctx)).resolves.toBeUndefined();
    expect(db.queries.some((q) => q.sql.startsWith('UPDATE contact_requests'))).toBe(false);
  });

  it('generation mismatch — UPDATE матчит 0 строк, message сохранён', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.users.set(USER, { state: 'deleted', deletionId: 'other-generation' });

    await expect(adapter.execute(purgeJob(), ctx)).resolves.toBeUndefined();
    expect(db.requests[0].message).toBe(OWN_CANARY);
  });

  it('reactivation между discovery и execute — DeletionCancelledError, записи нет', async () => {
    const { db, adapter, ctx } = makeHarness();
    ctx.assertCurrent.mockRejectedValue(new DeletionCancelledError());

    await expect(adapter.execute(purgeJob(), ctx)).rejects.toBeInstanceOf(DeletionCancelledError);
    expect(db.requests[0].message).toBe(OWN_CANARY);
  });

  it('сбой БД — DeletionRetryError(kind db), message не тронут', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.failUpdate = true;

    await expect(adapter.execute(purgeJob(), ctx)).rejects.toMatchObject({ kind: 'db' });
    expect(db.requests[0].message).toBe(OWN_CANARY);
  });

  it('идемпотентность: повторный execute — тихий успех, состояние то же', async () => {
    const { db, adapter, ctx } = makeHarness();

    await adapter.execute(purgeJob(), ctx);
    await expect(adapter.execute(purgeJob(), ctx)).resolves.toBeUndefined();
    expect(db.requests[0].message).toBeNull();
    expect(db.requests).toHaveLength(3);
  });

  it('чужой resourceType — отказ', async () => {
    const { adapter, ctx } = makeHarness();

    await expect(
      adapter.execute(purgeJob({ resourceType: 'avatar.purge' }), ctx),
    ).rejects.toThrow('unsupported_deletion_resource');
  });
});

describe('ContactsService.createRequest — active guard (Task 17B)', () => {
  beforeEach(() => {
    canReceive.mockReset().mockResolvedValue(false);
  });

  it('deleted requester — BadRequest, INSERT не вызван', async () => {
    const { db } = makeHarness();
    const service = new ContactsService(db as any, null as any);

    await expect(service.createRequest(USER, OTHER_ID, OWN_CANARY))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(db.queries.some((q) => q.sql.startsWith('INSERT INTO contact_requests'))).toBe(false);
    expect(db.requests[0].message).toBe(OWN_CANARY);
  });

  it('живой requester проходит гейт (дальше — обычная логика доступности)', async () => {
    const { db } = makeHarness();
    const service = new ContactsService(db as any, null as any);

    // canReceiveNewProposal=false → PROFILE_NOT_AVAILABLE: доказывает, что
    // гейт не заблокировал активного пользователя.
    const error = await service.createRequest(OTHER, THIRD_ID, 'hello').then(
      () => null,
      (reason) => reason,
    );
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toEqual({ code: 'PROFILE_NOT_AVAILABLE' });
  });
});

describe('wiring contacts.purge (Task 17B)', () => {
  it('adapter регистрирует contacts.purge, ContactsModule его провайдит', () => {
    const registry = { register: jest.fn() } as any;
    const adapter = new ContactsAccountDeletionAdapter(registry);
    expect(adapter.resourceTypes).toEqual(['contacts.purge']);
    adapter.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(adapter);

    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, ContactsModule) ?? []).flat(Infinity);
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ContactsModule) ?? [];
    expect(imports.filter((item: unknown) => item === AccountDeletionModule)).toHaveLength(1);
    expect(providers.filter((item: unknown) => item === ContactsAccountDeletionAdapter)).toHaveLength(1);
  });

  it('catalog содержит discoverContactsDeletion ровно один раз', () => {
    expect(
      DELETION_DISCOVERERS.filter((item) => item === discoverContactsDeletion),
    ).toHaveLength(1);
  });
});
