import { MODULE_METADATA } from '@nestjs/common/constants';
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
import { SpeechModule } from './speech.module';
import { SpeechService } from './speech.service';
import {
  discoverSpeechDeletion,
  SpeechAccountDeletionAdapter,
} from './speech-account-deletion.adapter';

/**
 * Task 13 — speech_clips и speech_listens при удалении аккаунта.
 *
 * Объект клипа audio/<cache_key>.mp3 — ОБЩИЙ кеш: cache_key это sha256(text +
 * voice + lang), и тот же текст тем же голосом у соседа даёт тот же объект в
 * MinIO. Purge удаляет объект только когда на cache_key нет чужих строк
 * (reference count), своя row удаляется всегда. Listen-куски
 * audio/listen/<cache_key>-<nonce>-<i>.mp3 содержат случайный nonce строки и
 * никому не общие — удаляются строго по одному ДО удаления row.
 *
 * В payload живут только технические {clipId}/{listenId}: тексты, cache_key и
 * URL план не покидают.
 */

const MINIO_BASE = 'https://minio.test';
const SPEECH_BUCKET = 'linkeon-assets';
const USER = 'u-deleted';
const OTHER = 'u-other';
const deletionId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const account: DeletionAccount = {
  userId: USER,
  deletionId,
  deletedAt: new Date('2026-11-14T00:00:00Z'),
};

const CACHE_KEY = 'ab'.repeat(32); // sha256-hex, 64 символа
const NONCE = '0123456789abcdef'; // randomBytes(8).toString('hex')

interface ClipRow {
  id: string;
  user_id: string;
  cache_key: string;
  url: string;
}

interface ListenRow {
  id: string;
  user_id: string;
  cache_key: string;
  parts: string[];
}

/**
 * Фейковая БД: семантика SQL доменных методов (чтение row с generation
 * predicate, reference count общего кэша, transaction BEGIN → re-check →
 * DELETE → COMMIT). Настоящий SQL исполняется в
 * speech-account-deletion.pg.spec.ts. Журнал calls общий с фейковым storage —
 * по нему проверяется порядок «объекты до row».
 */
class FakeSpeechDb {
  readonly users = new Map<string, { state: string; deletionId: string | null }>();
  speechClips: ClipRow[] = [];
  speechListens: ListenRow[] = [];
  readonly queries: Array<{ sql: string; params: any[] }> = [];
  readonly calls: string[] = [];
  failGenRecheck = false;

  async query(sql: string, params: any[] = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    this.queries.push({ sql: s, params });

    if (/^BEGIN/i.test(s) || /^COMMIT/i.test(s) || /^ROLLBACK/i.test(s)) {
      return { rows: [], rowCount: 0 };
    }
    // Discovery: keyset-страницы clip-id удалённого поколения.
    if (s.startsWith('SELECT s.id FROM speech_clips s')) {
      const [userId, lastId, genId, pageSize] = params as [string, string | null, string, number];
      if (!this.isCurrentDeletion(String(userId), String(genId))) return { rows: [], rowCount: 0 };
      const rows = this.speechClips
        .filter((r) => r.user_id === userId && String(r.id) > String(lastId ?? ''))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, Number(pageSize))
        .map((r) => ({ id: r.id }));
      return { rows, rowCount: rows.length };
    }
    // Discovery: keyset-страницы listen-id удалённого поколения.
    if (s.startsWith('SELECT l.id FROM speech_listens l')) {
      const [userId, lastId, genId, pageSize] = params as [string, string | null, string, number];
      if (!this.isCurrentDeletion(String(userId), String(genId))) return { rows: [], rowCount: 0 };
      const rows = this.speechListens
        .filter((r) => r.user_id === userId && String(r.id) > String(lastId ?? ''))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, Number(pageSize))
        .map((r) => ({ id: r.id }));
      return { rows, rowCount: rows.length };
    }
    // Доменное чтение клипа с generation predicate.
    if (s.startsWith('SELECT id, cache_key FROM speech_clips')) {
      const [clipId, userId, genId] = params as [string, string, string];
      if (!this.isCurrentDeletion(String(userId), String(genId))) return { rows: [], rowCount: 0 };
      const row = this.speechClips.find((r) => r.id === clipId && r.user_id === userId);
      return row
        ? { rows: [{ id: row.id, cache_key: row.cache_key }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    // Reference count общего кэша: сколько ЧУЖИХ строк ссылаются на cache_key.
    if (s.startsWith('SELECT count(*)::int AS others FROM speech_clips')) {
      const [cacheKey, userId] = params as [string, string];
      const others = this.speechClips.filter(
        (r) => r.cache_key === cacheKey && r.user_id !== userId,
      ).length;
      return { rows: [{ others }], rowCount: 1 };
    }
    // Доменное чтение listen-строки с generation predicate.
    if (s.startsWith('SELECT id, cache_key, parts FROM speech_listens')) {
      const [listenId, userId, genId] = params as [string, string, string];
      if (!this.isCurrentDeletion(String(userId), String(genId))) return { rows: [], rowCount: 0 };
      const row = this.speechListens.find((r) => r.id === listenId && r.user_id === userId);
      return row
        ? { rows: [{ id: row.id, cache_key: row.cache_key, parts: row.parts }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    // Generation predicate / re-check внутри transaction.
    if (s.startsWith('SELECT 1 FROM user_id')) {
      const [userId, genId] = params as [string, string];
      const ok = !this.failGenRecheck && this.isCurrentDeletion(String(userId), String(genId));
      return ok ? { rows: [{ n: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('DELETE FROM speech_clips')) {
      const [clipId, userId, genId] = params as [string, string, string];
      if (!this.isCurrentDeletion(String(userId), String(genId))) return { rows: [], rowCount: 0 };
      const before = this.speechClips.length;
      this.speechClips = this.speechClips.filter(
        (r) => !(r.id === clipId && r.user_id === userId),
      );
      this.calls.push('db.deleteSpeechClip');
      return { rows: [], rowCount: before - this.speechClips.length };
    }
    if (s.startsWith('DELETE FROM speech_listens')) {
      const [listenId, userId, genId] = params as [string, string, string];
      if (!this.isCurrentDeletion(String(userId), String(genId))) return { rows: [], rowCount: 0 };
      const before = this.speechListens.length;
      this.speechListens = this.speechListens.filter(
        (r) => !(r.id === listenId && r.user_id === userId),
      );
      this.calls.push('db.deleteListen');
      return { rows: [], rowCount: before - this.speechListens.length };
    }
    throw new Error(`unexpected query: ${s}`);
  }

  async getClient() {
    return {
      query: (sql: string, params?: any[]) => this.query(sql, params),
      release: () => undefined,
    };
  }

  isCurrentDeletion(userId: string, genId: string): boolean {
    const u = this.users.get(userId);
    return u?.state === 'deleted' && u.deletionId === genId;
  }
}

function makeStorage(calls: string[]) {
  const deleteMock = jest.fn(async (_input: { bucket: string; key: string }) => undefined);
  const deleteConfirmed = jest.fn(async (input: { bucket: string; key: string }) => {
    try {
      await deleteMock(input);
    } catch (e: any) {
      // Семантика StorageService.deleteConfirmed: 404/NoSuchKey/NotFound —
      // подтверждённое отсутствие, остальное пробрасывается.
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
  const db = new FakeSpeechDb();
  db.users.set(USER, { state: 'deleted', deletionId });
  const storage = makeStorage(db.calls);
  const svc = new SpeechService(db as any, storage as any, null as any, null as any);
  const registry = new AccountDeletionRegistry();
  const adapter = new SpeechAccountDeletionAdapter(svc, registry);
  const assertCurrent = jest.fn(async () => undefined);
  const ctx: DeletionExecution & { assertCurrent: jest.Mock } = { db, assertCurrent };
  return { db, storage, svc, registry, adapter, ctx };
}

function purgeJob(
  resourceType: 'speech.purge' | 'listen.purge',
  payload: Record<string, unknown>,
  overrides: Partial<DeletionJobRow> = {},
): DeletionJobRow {
  return {
    id: 'job-speech-1',
    deletionId,
    userId: USER,
    resourceType,
    resourceKey: 'clip-own',
    phase: 'purge',
    payload,
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date('2026-12-14T00:00:00Z'),
    leaseUntil: new Date('2026-12-14T01:00:00Z'),
    lastErrorKind: null,
    ...overrides,
  };
}

function seedClip(db: FakeSpeechDb, overrides: Partial<ClipRow> = {}): ClipRow {
  const row: ClipRow = {
    id: 'clip-own',
    user_id: USER,
    cache_key: CACHE_KEY,
    url: `${MINIO_BASE}/${SPEECH_BUCKET}/audio/${CACHE_KEY}.mp3`,
    ...overrides,
  };
  db.speechClips.push(row);
  return row;
}

function listenParts(cacheKey = CACHE_KEY, count = 2): string[] {
  return Array.from(
    { length: count },
    (_, i) => `${MINIO_BASE}/${SPEECH_BUCKET}/audio/listen/${cacheKey}-${NONCE}-${i}.mp3`,
  );
}

function seedListen(db: FakeSpeechDb, overrides: Partial<ListenRow> = {}): ListenRow {
  const row: ListenRow = {
    id: 'listen-own',
    user_id: USER,
    cache_key: CACHE_KEY,
    parts: listenParts(),
    ...overrides,
  };
  db.speechListens.push(row);
  return row;
}

describe('discoverSpeechDeletion — speech.purge/listen.purge по каноническим строкам (Task 13)', () => {
  it('на каждую строку — job только с техническим id, без текстов и URL', async () => {
    const { db, storage } = makeHarness();
    seedClip(db, { id: 'clip-a' });
    seedClip(db, { id: 'clip-b', cache_key: 'cd'.repeat(32) });
    seedClip(db, { id: 'clip-x', user_id: OTHER });
    seedListen(db, { id: 'listen-a' });
    db.speechListens.push({
      id: 'listen-x', user_id: OTHER, cache_key: 'ef'.repeat(32), parts: [],
    });

    const plan = await discoverSpeechDeletion({ db, account, origin: 'explicit' });

    expect(plan.jobs).toEqual([
      { resourceType: 'speech.purge', resourceKey: 'clip-a', phase: 'purge', payload: { clipId: 'clip-a' } },
      { resourceType: 'speech.purge', resourceKey: 'clip-b', phase: 'purge', payload: { clipId: 'clip-b' } },
      { resourceType: 'listen.purge', resourceKey: 'listen-a', phase: 'purge', payload: { listenId: 'listen-a' } },
    ]);
    expect(plan.skips).toEqual([]);
    const json = JSON.stringify(plan.jobs);
    expect(json).not.toContain(USER);
    expect(json).not.toContain('minio.test');
    expect(json).not.toContain(CACHE_KEY);
    for (const job of plan.jobs) expect(() => safeDeletionJobSnapshot(job, USER)).not.toThrow();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
  });

  it('keyset-пагинация: страницы читаются до пустой (clips и listens)', async () => {
    const { db } = makeHarness();
    for (let i = 0; i < 5; i += 1) seedClip(db, { id: `clip-${i}` });
    for (let i = 0; i < 3; i += 1) seedListen(db, { id: `listen-${i}` });

    const plan = await discoverSpeechDeletion({ db, account, origin: 'explicit', pageSize: 2 });

    expect(plan.jobs).toHaveLength(8);
    const clipPages = db.queries.filter((q) => q.sql.startsWith('SELECT s.id FROM speech_clips s'));
    const listenPages = db.queries.filter((q) => q.sql.startsWith('SELECT l.id FROM speech_listens l'));
    expect(clipPages.length).toBeGreaterThanOrEqual(3);
    expect(listenPages.length).toBeGreaterThanOrEqual(2);
  });

  it('reactivation (поколение не совпало) — план пустой', async () => {
    const { db } = makeHarness();
    seedClip(db);
    seedListen(db);
    db.users.set(USER, { state: 'active', deletionId: null });

    const plan = await discoverSpeechDeletion({ db, account, origin: 'explicit' });

    expect(plan).toEqual({ jobs: [], skips: [] });
  });
});

describe('SpeechAccountDeletionAdapter.execute — speech.purge (Task 13)', () => {
  it('единоличный владелец: общий mp3 удалён до row', async () => {
    const { db, storage, adapter, ctx } = makeHarness();
    seedClip(db);

    await adapter.execute(purgeJob('speech.purge', { clipId: 'clip-own' }), ctx);

    expect(storage.deleteConfirmed).toHaveBeenCalledWith({
      bucket: SPEECH_BUCKET,
      key: `audio/${CACHE_KEY}.mp3`,
    });
    const objectAt = db.calls.indexOf(`storage.delete:${SPEECH_BUCKET}/audio/${CACHE_KEY}.mp3`);
    const rowAt = db.calls.indexOf('db.deleteSpeechClip');
    expect(objectAt).toBeGreaterThanOrEqual(0);
    expect(rowAt).toBeGreaterThanOrEqual(0);
    expect(objectAt).toBeLessThan(rowAt);
    expect(db.speechClips).toHaveLength(0);
    expect(ctx.assertCurrent).toHaveBeenCalled();
  });

  it('одинаковый cache_key у соседа: удаляет свою row, сохраняет общий mp3', async () => {
    const { db, storage, adapter, ctx } = makeHarness();
    const own = seedClip(db);
    db.speechClips.push({ ...own, id: 'clip-other', user_id: OTHER });

    await adapter.execute(purgeJob('speech.purge', { clipId: 'clip-own' }), ctx);

    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
    expect(db.speechClips.map((r) => r.id)).toEqual(['clip-other']);
  });

  it('MinIO-сбой: row и technical id остаются, retry timeout', async () => {
    const { db, storage, adapter, ctx } = makeHarness();
    seedClip(db);
    storage.delete.mockRejectedValue({ code: 'ETIMEDOUT' });

    await expect(adapter.execute(purgeJob('speech.purge', { clipId: 'clip-own' }), ctx))
      .rejects.toMatchObject({ kind: 'timeout' });
    expect(db.speechClips).toHaveLength(1);
    expect(db.calls).not.toContain('db.deleteSpeechClip');
  });

  it('объекта уже нет (NoSuchKey) — подтверждённое отсутствие, row удаляется', async () => {
    const { db, storage, adapter, ctx } = makeHarness();
    seedClip(db);
    storage.delete.mockRejectedValue(Object.assign(new Error('gone'), { name: 'NoSuchKey' }));

    await adapter.execute(purgeJob('speech.purge', { clipId: 'clip-own' }), ctx);

    expect(db.speechClips).toHaveLength(0);
  });

  it('повторный вызов при отсутствии row — идемпотентный success', async () => {
    const { db, storage, adapter, ctx } = makeHarness();

    await adapter.execute(purgeJob('speech.purge', { clipId: 'clip-own' }), ctx);

    expect(db.speechClips).toHaveLength(0);
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
    expect(db.queries.some((q) => q.sql.startsWith('DELETE FROM speech_clips'))).toBe(false);
  });

  it('reactivation между объектом и row — DeletionCancelledError, row остаётся', async () => {
    const { db, adapter, ctx } = makeHarness();
    seedClip(db);
    db.failGenRecheck = true;

    await expect(adapter.execute(purgeJob('speech.purge', { clipId: 'clip-own' }), ctx))
      .rejects.toBeInstanceOf(DeletionCancelledError);
    expect(db.speechClips).toHaveLength(1);
  });

  it('payload без clipId / с небезопасным clipId — retry db, сервис не вызывается', async () => {
    const { db, svc, adapter, ctx } = makeHarness();
    seedClip(db);
    const spy = jest.spyOn(svc, 'deleteSpeechClipForDeletion');

    await expect(adapter.execute(purgeJob('speech.purge', {}), ctx))
      .rejects.toMatchObject({ kind: 'db' });
    await expect(adapter.execute(purgeJob('speech.purge', { clipId: '../../etc' }), ctx))
      .rejects.toBeInstanceOf(DeletionRetryError);
    expect(spy).not.toHaveBeenCalled();
    expect(db.speechClips).toHaveLength(1);
  });
});

describe('SpeechAccountDeletionAdapter.execute — listen.purge (Task 13)', () => {
  it('nonce-куски удаляются строго по одному до row', async () => {
    const { db, storage, adapter, ctx } = makeHarness();
    seedListen(db);

    await adapter.execute(purgeJob('listen.purge', { listenId: 'listen-own' }, { resourceKey: 'listen-own' }), ctx);

    expect(db.calls).toEqual([
      `storage.delete:${SPEECH_BUCKET}/audio/listen/${CACHE_KEY}-${NONCE}-0.mp3`,
      `storage.delete:${SPEECH_BUCKET}/audio/listen/${CACHE_KEY}-${NONCE}-1.mp3`,
      'db.deleteListen',
    ]);
    expect(storage.deleteConfirmed).toHaveBeenCalledTimes(2);
    expect(db.speechListens).toHaveLength(0);
  });

  it('MinIO-сбой на втором куске: row остаётся, retry продолжается с тем же listenId', async () => {
    const { db, storage, adapter, ctx } = makeHarness();
    seedListen(db);
    storage.delete.mockImplementationOnce(async () => undefined);
    storage.delete.mockRejectedValueOnce({ code: 'ETIMEDOUT' });

    await expect(
      adapter.execute(purgeJob('listen.purge', { listenId: 'listen-own' }, { resourceKey: 'listen-own' }), ctx),
    ).rejects.toMatchObject({ kind: 'timeout' });

    expect(db.speechListens).toHaveLength(1);
    expect(db.calls).not.toContain('db.deleteListen');

    // Retry с тем же payload: первый кусок уже absent, второй и row дожимаются.
    storage.delete.mockRejectedValue(Object.assign(new Error('gone'), { name: 'NoSuchKey' }));
    await adapter.execute(purgeJob('listen.purge', { listenId: 'listen-own' }, { resourceKey: 'listen-own' }), ctx);
    expect(db.speechListens).toHaveLength(0);
  });

  it('чужой URL в parts — не наш объект: пропускается, row удаляется', async () => {
    const { db, storage, adapter, ctx } = makeHarness();
    seedListen(db, { parts: ['https://cdn.example.com/a.mp3', ...listenParts(CACHE_KEY, 1)] });

    await adapter.execute(purgeJob('listen.purge', { listenId: 'listen-own' }, { resourceKey: 'listen-own' }), ctx);

    expect(storage.deleteConfirmed).toHaveBeenCalledTimes(1);
    expect(storage.deleteConfirmed).toHaveBeenCalledWith({
      bucket: SPEECH_BUCKET,
      key: `audio/listen/${CACHE_KEY}-${NONCE}-0.mp3`,
    });
    expect(db.speechListens).toHaveLength(0);
  });

  it('part нашего бакета вне шаблона listen-ключа — retry db, ничего не удалено', async () => {
    const { db, storage, adapter, ctx } = makeHarness();
    seedListen(db, {
      parts: [`${MINIO_BASE}/${SPEECH_BUCKET}/avatars/users/someone.jpg`],
    });

    await expect(
      adapter.execute(purgeJob('listen.purge', { listenId: 'listen-own' }, { resourceKey: 'listen-own' }), ctx),
    ).rejects.toMatchObject({ kind: 'db' });
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
    expect(db.speechListens).toHaveLength(1);
  });

  it('повторный вызов при отсутствии row — идемпотентный success', async () => {
    const { db, storage, adapter, ctx } = makeHarness();

    await adapter.execute(purgeJob('listen.purge', { listenId: 'listen-own' }, { resourceKey: 'listen-own' }), ctx);

    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
    expect(db.queries.some((q) => q.sql.startsWith('DELETE FROM speech_listens'))).toBe(false);
  });
});

describe('SpeechAccountDeletionAdapter.execute — общее (Task 13)', () => {
  it('чужой resourceType — отказ', async () => {
    const { adapter, ctx } = makeHarness();
    const job = {
      ...purgeJob('speech.purge', { clipId: 'clip-own' }),
      resourceType: 'image.purge' as const,
    };

    await expect(adapter.execute(job, ctx)).rejects.toThrow('unsupported_deletion_resource');
  });

  it('assertCurrent зовётся до чтения строк и после внешних операций', async () => {
    const { adapter, ctx } = makeHarness();

    await adapter.execute(purgeJob('speech.purge', { clipId: 'clip-own' }), ctx);

    expect(ctx.assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('wiring speech.purge/listen.purge (Task 13)', () => {
  it('adapter регистрирует оба типа, SpeechModule его провайдит', () => {
    const registry = { register: jest.fn() } as any;
    const adapter = new SpeechAccountDeletionAdapter({} as any, registry);
    expect(adapter.resourceTypes).toEqual(['speech.purge', 'listen.purge']);
    adapter.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(adapter);

    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, SpeechModule) ?? []).flat(Infinity);
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, SpeechModule) ?? [];
    expect(imports.filter((item: unknown) => item === AccountDeletionModule)).toHaveLength(1);
    expect(providers.filter((item: unknown) => item === SpeechAccountDeletionAdapter)).toHaveLength(1);
  });

  it('catalog содержит discoverSpeechDeletion', () => {
    expect(DELETION_DISCOVERERS).toContain(discoverSpeechDeletion);
  });
});
