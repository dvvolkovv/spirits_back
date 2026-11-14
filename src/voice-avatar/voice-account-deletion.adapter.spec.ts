import axios from 'axios';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import { DELETION_DISCOVERERS } from '../account-deletion/account-deletion.catalog';
import {
  DeletionCancelledError,
  DeletionRetryError,
  deletionResourceHash,
  safeDeletionJobSnapshot,
} from '../account-deletion/account-deletion.safe';
import type {
  DeletionAccount,
  DeletionExecution,
  DeletionJobRow,
} from '../account-deletion/account-deletion.types';
import { VoiceAvatarModule } from './voice-avatar.module';
import { VoiceAvatarService } from './voice-avatar.service';
import {
  discoverVoiceAvatarDeletion,
  VoiceAvatarAccountDeletionAdapter,
} from './voice-account-deletion.adapter';

jest.mock('axios');

/**
 * Task 14 — клон голоса ElevenLabs при удалении аккаунта.
 *
 * Каноническая строка — user_voice (PK user_id, один клон на пользователя):
 * discovery снимает snapshot внешнего voice_id ДО любого stop и сохраняет в
 * payload только технический {voiceId}. Purge строгий: неподтверждённый исход
 * (timeout/5xx/нет ключа/пустая ошибка) — retry, внешний id и row переживают
 * попытку; 404 — подтверждённое отсутствие (идемпотентно); row удаляется
 * только после подтверждения и только под generation predicate.
 * Интерактивные deleteClone/removeVoice не меняются.
 */

const USER = 'u-deleted';
const OTHER = 'u-other';
const VOICE_ID = 'voice-external-1';
const CANARY = 'ЛИЧНЫЙ-ТЕКСТ';
const deletionId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const account: DeletionAccount = {
  userId: USER,
  deletionId,
  deletedAt: new Date('2026-11-12T00:00:00Z'),
};

const del = axios.delete as jest.Mock;

// Гигиена: env восстанавливается по образцу pg-спеков — спек не должен
// оставлять ELEVENLABS_API_KEY соседним файлам в одном воркере jest.
let prevKey: string | undefined;
beforeAll(() => {
  prevKey = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = 'el-key-placeholder-for-spec';
});
afterAll(() => {
  if (prevKey === undefined) delete process.env.ELEVENLABS_API_KEY;
  else process.env.ELEVENLABS_API_KEY = prevKey;
});

interface UserVoiceRow {
  user_id: string;
  elevenlabs_voice_id: string | null;
  voice_descriptor: string | null;
  sample_url: string | null;
}

/**
 * Фейковая БД: повторяет семантику SQL адаптера (discovery-SELECT, SELECT
 * существования row с generation predicate, DELETE с generation predicate).
 * Настоящий SQL исполняется в voice-account-deletion.pg.spec.ts. Журнал calls
 * общий с внешним вызовом: порядок «подтверждение до row» проверяется по нему.
 */
class FakeVoiceDb {
  readonly users = new Map<string, { state: string; deletionId: string | null }>();
  userVoice: UserVoiceRow[] = [];
  readonly queries: Array<{ sql: string; params: any[] }> = [];
  /** Общий журнал вызовов db+ElevenLabs (порядок операций). */
  readonly calls: string[] = [];

  async query(sql: string, params: any[] = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    this.queries.push({ sql: s, params });

    // Discovery: snapshot внешнего voice_id удалённого поколения.
    if (s.startsWith('SELECT v.elevenlabs_voice_id FROM user_voice')) {
      const [userId, genId] = params as [string, string];
      if (!this.isCurrentDeletion(String(userId), String(genId))) return { rows: [], rowCount: 0 };
      const rows = this.userVoice
        .filter((r) => r.user_id === userId && r.elevenlabs_voice_id)
        .map((r) => ({ elevenlabs_voice_id: r.elevenlabs_voice_id }));
      return { rows, rowCount: rows.length };
    }
    // Проверка существования row перед внешним вызовом (idempotent re-run).
    if (s.startsWith('SELECT 1 FROM user_voice')) {
      const [userId, voiceId, genId] = params as [string, string, string];
      if (!this.isCurrentDeletion(String(userId), String(genId))) return { rows: [], rowCount: 0 };
      const found = this.userVoice.some(
        (r) => r.user_id === userId && r.elevenlabs_voice_id === voiceId,
      );
      return found ? { rows: [{ n: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('DELETE FROM user_voice')) {
      const [userId, voiceId, genId] = params as [string, string, string];
      if (!this.isCurrentDeletion(String(userId), String(genId))) return { rows: [], rowCount: 0 };
      const before = this.userVoice.length;
      this.userVoice = this.userVoice.filter(
        (r) => !(r.user_id === userId && r.elevenlabs_voice_id === voiceId),
      );
      this.calls.push('db.deleteUserVoice');
      return { rows: [], rowCount: before - this.userVoice.length };
    }
    throw new Error(`unexpected query: ${s}`);
  }

  isCurrentDeletion(userId: string, genId: string): boolean {
    const u = this.users.get(userId);
    return u?.state === 'deleted' && u.deletionId === genId;
  }
}

function makeHarness() {
  const db = new FakeVoiceDb();
  db.users.set(USER, { state: 'deleted', deletionId });
  // Успешный внешний вызов по умолчанию; журнал — общий с db (порядок).
  del.mockReset();
  del.mockImplementation(async () => {
    db.calls.push('elevenlabs.delete');
    return { status: 200, data: {} };
  });
  const svc = new VoiceAvatarService(null as any);
  const registry = new AccountDeletionRegistry();
  const adapter = new VoiceAvatarAccountDeletionAdapter(svc, registry);
  const assertCurrent = jest.fn(async () => undefined);
  const ctx: DeletionExecution & { assertCurrent: jest.Mock } = { db, assertCurrent };
  return { db, svc, registry, adapter, ctx };
}

function voiceJob(
  payload: Record<string, unknown> = { voiceId: VOICE_ID },
  overrides: Partial<DeletionJobRow> = {},
): DeletionJobRow {
  return {
    id: 'job-voice-1',
    deletionId,
    userId: USER,
    resourceType: 'elevenlabs-voice.purge',
    resourceKey: deletionResourceHash('elevenlabs-voice', VOICE_ID),
    phase: 'purge',
    payload,
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date('2026-12-12T00:00:00Z'),
    leaseUntil: new Date('2026-12-12T01:00:00Z'),
    lastErrorKind: null,
    ...overrides,
  };
}

function seedRow(db: FakeVoiceDb, overrides: Partial<UserVoiceRow> = {}): UserVoiceRow {
  const row: UserVoiceRow = {
    user_id: USER,
    elevenlabs_voice_id: VOICE_ID,
    voice_descriptor: CANARY,
    sample_url: `https://minio.test/linkeon-assets/voice/${CANARY}.mp3`,
    ...overrides,
  };
  db.userVoice.push(row);
  return row;
}

describe('discoverVoiceAvatarDeletion — elevenlabs-voice.purge по user_voice (Task 14)', () => {
  it('snapshot voiceId до любого stop; payload только технический, без PII', async () => {
    const { db } = makeHarness();
    seedRow(db);

    const plan = await discoverVoiceAvatarDeletion({ db, account, origin: 'explicit' });

    expect(plan.jobs).toEqual([{
      resourceType: 'elevenlabs-voice.purge',
      resourceKey: deletionResourceHash('elevenlabs-voice', VOICE_ID),
      phase: 'purge',
      payload: { voiceId: VOICE_ID },
    }]);
    expect(plan.skips).toEqual([]);
    const json = JSON.stringify(plan.jobs);
    expect(json).not.toContain(CANARY);
    expect(json).not.toContain(USER);
    expect(json).not.toContain('minio.test');
    // Job проходит fail-closed sanitizer плана.
    for (const job of plan.jobs) expect(() => safeDeletionJobSnapshot(job, USER)).not.toThrow();
    // Discovery ничего не удаляет — ни внешне, ни в БД.
    expect(del).not.toHaveBeenCalled();
    expect(db.userVoice).toHaveLength(1);
  });

  it('без elevenlabs_voice_id (NULL) — job не создаётся', async () => {
    const { db } = makeHarness();
    seedRow(db, { elevenlabs_voice_id: null });

    const plan = await discoverVoiceAvatarDeletion({ db, account, origin: 'explicit' });

    expect(plan).toEqual({ jobs: [], skips: [] });
  });

  it('чужая строка не попадает в план; reactivation — план пустой', async () => {
    const { db } = makeHarness();
    seedRow(db, { user_id: OTHER, elevenlabs_voice_id: 'voice-other' });

    const plan = await discoverVoiceAvatarDeletion({ db, account, origin: 'explicit' });
    expect(plan).toEqual({ jobs: [], skips: [] });

    db.userVoice = [];
    seedRow(db);
    db.users.set(USER, { state: 'active', deletionId: null });
    const revived = await discoverVoiceAvatarDeletion({ db, account, origin: 'explicit' });
    expect(revived).toEqual({ jobs: [], skips: [] });
  });
});

describe('VoiceAvatarAccountDeletionAdapter.execute — строгий purge (Task 14)', () => {
  it.each([
    { failure: { code: 'ETIMEDOUT' }, kind: 'timeout' },
    { failure: { response: { status: 500 } }, kind: 'external_5xx' },
    { failure: {}, kind: 'external_unknown' },
  ])('unknown ElevenLabs outcome = retry ($kind), external ID не теряется', async ({ failure, kind }) => {
    const { db, adapter, ctx } = makeHarness();
    seedRow(db);
    del.mockReset();
    del.mockRejectedValue(failure);
    const job = voiceJob();

    await expect(adapter.execute(job, ctx)).rejects.toBeInstanceOf(DeletionRetryError);
    await expect(adapter.execute(job, ctx)).rejects.toMatchObject({ kind });
    expect(db.userVoice[0].elevenlabs_voice_id).toBe(VOICE_ID);
    expect(job.payload).toEqual({ voiceId: VOICE_ID });
    expect(db.calls).not.toContain('db.deleteUserVoice');
    expect(db.userVoice).toHaveLength(1);
  });

  it('404 = confirmed absence, затем удаляется локальная row', async () => {
    const { db, adapter, ctx } = makeHarness();
    seedRow(db);
    del.mockReset();
    del.mockRejectedValue({ response: { status: 404 } });

    await adapter.execute(voiceJob(), ctx);

    expect(db.userVoice).toHaveLength(0);
  });

  it('200 = deleted: подтверждение ДО удаления row', async () => {
    const { db, adapter, ctx } = makeHarness();
    seedRow(db);

    await adapter.execute(voiceJob(), ctx);

    const extAt = db.calls.indexOf('elevenlabs.delete');
    const rowAt = db.calls.indexOf('db.deleteUserVoice');
    expect(extAt).toBeGreaterThanOrEqual(0);
    expect(rowAt).toBeGreaterThanOrEqual(0);
    expect(extAt).toBeLessThan(rowAt);
    expect(db.userVoice).toHaveLength(0);
    expect(del).toHaveBeenCalledWith(
      `https://api.elevenlabs.io/v1/voices/${VOICE_ID}`,
      expect.objectContaining({ headers: { 'xi-api-key': 'el-key-placeholder-for-spec' } }),
    );
  });

  it('нет ELEVENLABS_API_KEY — retry external_unknown, row и ID целы, сети нет', async () => {
    const { db, adapter, ctx } = makeHarness();
    seedRow(db);
    const saved = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    try {
      await expect(adapter.execute(voiceJob(), ctx))
        .rejects.toMatchObject({ kind: 'external_unknown' });
    } finally {
      process.env.ELEVENLABS_API_KEY = saved;
    }
    expect(del).not.toHaveBeenCalled();
    expect(db.userVoice[0].elevenlabs_voice_id).toBe(VOICE_ID);
    expect(db.calls).not.toContain('db.deleteUserVoice');
  });

  it('reactivation до external — DeletionCancelledError, row цела, сети нет', async () => {
    const { db, adapter, ctx } = makeHarness();
    seedRow(db);
    ctx.assertCurrent.mockRejectedValue(new DeletionCancelledError());

    await expect(adapter.execute(voiceJob(), ctx))
      .rejects.toBeInstanceOf(DeletionCancelledError);
    expect(del).not.toHaveBeenCalled();
    expect(db.userVoice).toHaveLength(1);
  });

  it('reactivation после external — DeletionCancelledError, row цела', async () => {
    const { db, adapter, ctx } = makeHarness();
    seedRow(db);
    ctx.assertCurrent
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new DeletionCancelledError());

    await expect(adapter.execute(voiceJob(), ctx))
      .rejects.toBeInstanceOf(DeletionCancelledError);
    expect(db.userVoice).toHaveLength(1);
    expect(db.calls).not.toContain('db.deleteUserVoice');
  });

  it('повторный execute без строки — идемпотентный успех без external вызова', async () => {
    const { db, adapter, ctx } = makeHarness();

    await adapter.execute(voiceJob(), ctx);

    expect(db.userVoice).toHaveLength(0);
    expect(del).not.toHaveBeenCalled();
    expect(db.queries.some((q) => q.sql.startsWith('DELETE FROM user_voice'))).toBe(false);
  });

  it('поколение не совпало в БД (reactivation мимо assertCurrent) — row не удаляется', async () => {
    const { db, adapter, ctx } = makeHarness();
    seedRow(db);
    db.users.set(USER, { state: 'active', deletionId: null });

    await adapter.execute(voiceJob(), ctx);

    expect(db.userVoice).toHaveLength(1);
    expect(del).not.toHaveBeenCalled();
    expect(db.calls).not.toContain('db.deleteUserVoice');
  });

  it('payload без строкового voiceId — retry db, external не вызывается', async () => {
    const { db, adapter, ctx } = makeHarness();
    seedRow(db);

    for (const payload of [{}, { voiceId: 42 }, { voiceId: '' }, { voiceId: '  ' }]) {
      await expect(adapter.execute(voiceJob(payload), ctx))
        .rejects.toMatchObject({ kind: 'db' });
    }
    expect(del).not.toHaveBeenCalled();
    expect(db.userVoice).toHaveLength(1);
  });

  it('чужой resourceType — отказ', async () => {
    const { adapter, ctx } = makeHarness();
    const job = { ...voiceJob(), resourceType: 'voice.purge' as const };

    await expect(adapter.execute(job, ctx)).rejects.toThrow('unsupported_deletion_resource');
  });

  it('assertCurrent зовётся до external и до DELETE', async () => {
    const { adapter, ctx } = makeHarness();

    await adapter.execute(voiceJob(), ctx);

    expect(ctx.assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('wiring elevenlabs-voice.purge (Task 14)', () => {
  it('adapter регистрирует elevenlabs-voice.purge, VoiceAvatarModule его провайдит', () => {
    const registry = { register: jest.fn() } as any;
    const svc = {} as any;
    const adapter = new VoiceAvatarAccountDeletionAdapter(svc, registry);
    expect(adapter.resourceTypes).toEqual(['elevenlabs-voice.purge']);
    adapter.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(adapter);

    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, VoiceAvatarModule) ?? []).flat(Infinity);
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, VoiceAvatarModule) ?? [];
    expect(imports.filter((item: unknown) => item === AccountDeletionModule)).toHaveLength(1);
    expect(providers.filter((item: unknown) => item === VoiceAvatarAccountDeletionAdapter)).toHaveLength(1);
  });

  it('catalog содержит discoverVoiceAvatarDeletion', () => {
    expect(DELETION_DISCOVERERS).toContain(discoverVoiceAvatarDeletion);
  });
});
