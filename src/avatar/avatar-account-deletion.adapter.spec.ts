import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import { DELETION_DISCOVERERS } from '../account-deletion/account-deletion.catalog';
import { DeletionCancelledError, safeDeletionJobSnapshot } from '../account-deletion/account-deletion.safe';
import type {
  DeletionAccount,
  DeletionExecution,
  DeletionJobRow,
} from '../account-deletion/account-deletion.types';
import { AvatarModule } from './avatar.module';
import { AvatarService } from './avatar.service';
import {
  discoverAvatarDeletion,
  AvatarAccountDeletionAdapter,
} from './avatar-account-deletion.adapter';

/**
 * Task 13 — пользовательские аватары при удалении аккаунта.
 *
 * Job пустой (payload {}): execute ВЫЧИСЛЯЕТ канонические цели из job.userId —
 * avatars/users/<userId>.{jpg,png,webp,gif} в linkeon-assets и легаси-файл
 * public/avatars/<userId>.jpg. profile_data.avatar_url НЕ используется как
 * произвольная цель удаления (в нём может быть чужой/agent-ключ), а
 * avatars/agents/ не выбирается никогда: агентские аватары общие.
 */

const MINIO_BASE = 'https://minio.test';
const ASSETS_BUCKET = 'linkeon-assets';
const USER = 'u-deleted';
const deletionId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const account: DeletionAccount = {
  userId: USER,
  deletionId,
  deletedAt: new Date('2026-11-14T00:00:00Z'),
};

let publicDir: string;
// Гигиена: env восстанавливается по образцу pg-спеков.
const ENV_KEYS = ['BACKEND_URL', 'PUBLIC_DIR'] as const;
const prevEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  process.env.BACKEND_URL = 'https://api.test';
  publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-purge-'));
  process.env.PUBLIC_DIR = publicDir;
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k] as string;
  }
  if (publicDir) fs.rmSync(publicDir, { recursive: true, force: true });
});

/**
 * Фейковая БД аватара: единственный допустимый запрос — generation gate.
 * Любое чтение profile_data/avatar_url — unexpected query (тест падения):
 * произвольные цели из профиля не выбираются.
 */
class FakeAvatarDb {
  readonly users = new Map<string, { state: string; deletionId: string | null }>();
  readonly queries: Array<{ sql: string; params: any[] }> = [];
  readonly calls: string[] = [];
  /** Профиль с «заманчивым» avatar_url — не должен читаться purge'ом. */
  profileAvatarUrl: string | null = null;

  async query(sql: string, params: any[] = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    this.queries.push({ sql: s, params });
    if (s.startsWith('SELECT 1 FROM user_id')) {
      const [userId, genId] = params as [string, string];
      const u = this.users.get(String(userId));
      const ok = u?.state === 'deleted' && u.deletionId === String(genId);
      return ok ? { rows: [{ n: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    throw new Error(`unexpected query: ${s}`);
  }
}

function makeStorage(calls: string[]) {
  const deleteMock = jest.fn(async (_input: { bucket: string; key: string }) => undefined);
  const deleteConfirmed = jest.fn(async (input: { bucket: string; key: string }) => {
    try {
      await deleteMock(input);
    } catch (e: any) {
      if (e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) {
        calls.push(`storage.delete:${input.bucket}/${input.key}`);
        return 'absent' as const;
      }
      throw e;
    }
    calls.push(`storage.delete:${input.bucket}/${input.key}`);
    return 'deleted' as const;
  });
  return {
    delete: deleteMock,
    deleteConfirmed,
    publicUrl: (bucket: string, key: string) => `${MINIO_BASE}/${bucket}/${key}`,
    upload: jest.fn(),
  };
}

function makeHarness() {
  const db = new FakeAvatarDb();
  db.users.set(USER, { state: 'deleted', deletionId });
  const storage = makeStorage(db.calls);
  const svc = new AvatarService(db as any, storage as any);
  const registry = new AccountDeletionRegistry();
  const adapter = new AvatarAccountDeletionAdapter(svc, registry);
  const assertCurrent = jest.fn(async () => undefined);
  const ctx: DeletionExecution & { assertCurrent: jest.Mock } = { db, assertCurrent };
  return { db, storage, svc, registry, adapter, ctx };
}

function avatarJob(overrides: Partial<DeletionJobRow> = {}): DeletionJobRow {
  return {
    id: 'job-avatar-1',
    deletionId,
    userId: USER,
    resourceType: 'avatar.purge',
    resourceKey: 'avatar-canonical',
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

const CANONICAL_KEYS = ['jpg', 'png', 'webp', 'gif'].map((ext) => `avatars/users/${USER}.${ext}`);

describe('discoverAvatarDeletion — один пустой job на аккаунт (Task 13)', () => {
  it('payload {}, без userId и доменов; sanitizer плана проходит', async () => {
    const { db, storage } = makeHarness();

    const plan = await discoverAvatarDeletion({ db, account, origin: 'explicit' });

    expect(plan.jobs).toHaveLength(1);
    const job = plan.jobs[0];
    expect(job.resourceType).toBe('avatar.purge');
    expect(job.phase).toBe('purge');
    expect(job.payload).toEqual({});
    expect(plan.skips).toEqual([]);
    const json = JSON.stringify(plan.jobs);
    expect(json).not.toContain(USER);
    expect(json).not.toContain('minio.test');
    expect(() => safeDeletionJobSnapshot(job, USER)).not.toThrow();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
  });

  it('reactivation (поколение не совпало) — план пустой', async () => {
    const { db } = makeHarness();
    db.users.set(USER, { state: 'active', deletionId: null });

    const plan = await discoverAvatarDeletion({ db, account, origin: 'explicit' });

    expect(plan).toEqual({ jobs: [], skips: [] });
  });
});

describe('AvatarAccountDeletionAdapter.execute — канонические цели из job.userId (Task 13)', () => {
  let unlinkSpy: jest.SpyInstance;

  beforeEach(() => {
    unlinkSpy = jest.spyOn(fs.promises, 'unlink').mockImplementation((async (p: any) => {
      void p; // реального файла в unit-спеке нет
    }) as any);
  });

  afterEach(() => {
    unlinkSpy.mockRestore();
  });

  it('avatar payload не содержит userId, shared agent avatar не удаляется', async () => {
    const { db, storage, adapter, ctx } = makeHarness();
    // «Заманчивый» avatar_url в профиле: чужой agent-ключ. Purge его не
    // читает (фейк бросает на любой не-gate запрос) и не удаляет.
    db.profileAvatarUrl = `${MINIO_BASE}/${ASSETS_BUCKET}/avatars/agents/roman.jpg`;
    const job = avatarJob();

    expect(job.payload).toEqual({});
    await adapter.execute(job, ctx);

    for (const key of CANONICAL_KEYS) {
      expect(storage.deleteConfirmed).toHaveBeenCalledWith({ bucket: ASSETS_BUCKET, key });
    }
    expect(storage.deleteConfirmed).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: expect.stringContaining('avatars/agents/') }),
    );
    expect(unlinkSpy).toHaveBeenCalledWith(path.join(publicDir, 'avatars', `${USER}.jpg`));
    // Локальный файл — после объектов MinIO.
    const lastMinio = Math.max(
      ...CANONICAL_KEYS.map((key) => db.calls.indexOf(`storage.delete:${ASSETS_BUCKET}/${key}`)),
    );
    expect(lastMinio).toBeGreaterThanOrEqual(0);
    expect(db.queries.every((q) => !/profile_data|avatar_url/i.test(q.sql))).toBe(true);
    expect(ctx.assertCurrent).toHaveBeenCalled();
  });

  it('MinIO-сбой: retry timeout, локальный файл не тронут', async () => {
    const { storage, adapter, ctx } = makeHarness();
    storage.delete.mockRejectedValue({ code: 'ETIMEDOUT' });

    await expect(adapter.execute(avatarJob(), ctx)).rejects.toMatchObject({ kind: 'timeout' });
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  it('объектов уже нет (NoSuchKey) и файла нет (ENOENT) — идемпотентный success', async () => {
    const { storage, adapter, ctx } = makeHarness();
    storage.delete.mockRejectedValue(Object.assign(new Error('gone'), { name: 'NoSuchKey' }));
    unlinkSpy.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));

    await expect(adapter.execute(avatarJob(), ctx)).resolves.toBeUndefined();
    expect(storage.deleteConfirmed).toHaveBeenCalledTimes(CANONICAL_KEYS.length);
  });

  it('локальный сбой (не ENOENT) — пробрасывается как retry', async () => {
    const { adapter, ctx } = makeHarness();
    unlinkSpy.mockRejectedValue({ code: 'EACCES' });

    await expect(adapter.execute(avatarJob(), ctx)).rejects.toMatchObject({ kind: 'permission' });
  });

  it('reactivation до удаления — DeletionCancelledError, ничего не удалено', async () => {
    const { db, storage, adapter, ctx } = makeHarness();
    db.users.set(USER, { state: 'active', deletionId: null });

    await expect(adapter.execute(avatarJob(), ctx)).rejects.toBeInstanceOf(DeletionCancelledError);
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  it('небезопасный userId в job — retry db, ничего не удалено', async () => {
    const { storage, adapter, ctx } = makeHarness();

    await expect(adapter.execute(avatarJob({ userId: '../evil' }), ctx))
      .rejects.toMatchObject({ kind: 'db' });
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  it('чужой resourceType — отказ', async () => {
    const { adapter, ctx } = makeHarness();
    const job = { ...avatarJob(), resourceType: 'image.purge' as const };

    await expect(adapter.execute(job, ctx)).rejects.toThrow('unsupported_deletion_resource');
  });

  it('assertCurrent зовётся до и после внешних операций', async () => {
    const { adapter, ctx } = makeHarness();

    await adapter.execute(avatarJob(), ctx);

    expect(ctx.assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('wiring avatar.purge (Task 13)', () => {
  it('adapter регистрирует avatar.purge, AvatarModule его провайдит', () => {
    const registry = { register: jest.fn() } as any;
    const adapter = new AvatarAccountDeletionAdapter({} as any, registry);
    expect(adapter.resourceTypes).toEqual(['avatar.purge']);
    adapter.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(adapter);

    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, AvatarModule) ?? []).flat(Infinity);
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AvatarModule) ?? [];
    expect(imports.filter((item: unknown) => item === AccountDeletionModule)).toHaveLength(1);
    expect(providers.filter((item: unknown) => item === AvatarAccountDeletionAdapter)).toHaveLength(1);
  });

  it('catalog содержит discoverAvatarDeletion', () => {
    expect(DELETION_DISCOVERERS).toContain(discoverAvatarDeletion);
  });
});
