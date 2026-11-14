import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
import { VideoModule } from './video.module';
import { VideoService } from './video.service';
import {
  discoverVideoDeletion,
  VideoAccountDeletionAdapter,
} from './video-account-deletion.adapter';

/**
 * Task 12 — video_jobs при удалении аккаунта.
 *
 * Каноническая строка — video_jobs: purge читает её сохранённые URL (включая
 * video-uploads/<userId>/… — из строки, НЕ из payload), удаляет каждый owned
 * MinIO-объект, локальный финальный MP4/JPG и staging _veoconcat строго
 * (await, без allSettled), затем в transaction удаляет row; TG delivery row
 * (tg_bot_video_jobs) уходит cascade'ом FK. Omni interaction ID (kling_task_id)
 * — не deletable файл: discovery фиксирует безопасный skip video.provider
 * unsupported_external, выдуманный cancel/delete API не вызывается.
 */

const MINIO_BASE = 'https://minio.test';
const BACKEND = 'https://api.test';
const VIDEO_BUCKET = 'linkeon-smm-videos';
const CANARY = 'ЛИЧНЫЙ-ПРОМПТ';
const USER = 'u-deleted';
const deletionId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const account: DeletionAccount = {
  userId: USER,
  deletionId,
  deletedAt: new Date('2026-11-12T00:00:00Z'),
};

let publicDir: string;

beforeAll(() => {
  process.env.BACKEND_URL = BACKEND;
  process.env.MINIO_BUCKET_VIDEOS = VIDEO_BUCKET;
  publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-purge-'));
  process.env.PUBLIC_DIR = publicDir;
});

interface VideoRow {
  id: string;
  user_id: string;
  kling_task_id?: string | null;
  video_url?: string | null;
  thumbnail_url?: string | null;
  source_image_url?: string | null;
  audio_url?: string | null;
}

/**
 * Фейковая БД: семантика SQL доменного метода (чтение row с generation
 * predicate, transaction BEGIN → re-check → DELETE → COMMIT). Настоящий SQL и
 * FK-cascade tg_bot_video_jobs исполняются в video-account-deletion.pg.spec.ts.
 * Журнал calls общий с фейковым storage и fs — по нему проверяется порядок
 * «объекты до row» (эквивалент toHaveBeenCalledBefore).
 */
class FakeVideoDb {
  readonly users = new Map<string, { state: string; deletionId: string | null }>();
  videoJobs: VideoRow[] = [];
  readonly queries: Array<{ sql: string; params: any[] }> = [];
  readonly calls: string[] = [];
  failGenRecheck = false;

  async query(sql: string, params: any[] = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    this.queries.push({ sql: s, params });

    if (/^BEGIN/i.test(s) || /^COMMIT/i.test(s) || /^ROLLBACK/i.test(s)) {
      return { rows: [], rowCount: 0 };
    }
    // Discovery: keyset-страницы по uuid удалённого поколения.
    if (s.startsWith('SELECT v.id, v.kling_task_id FROM video_jobs v')) {
      const [userId, lastId, genId, pageSize] = params as [string, string | null, string, number];
      if (!this.isCurrentDeletion(String(userId), String(genId))) return { rows: [], rowCount: 0 };
      const rows = this.videoJobs
        .filter((r) => r.user_id === userId && String(r.id) > String(lastId ?? ''))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, Number(pageSize))
        .map((r) => ({ id: r.id, kling_task_id: r.kling_task_id ?? null }));
      return { rows, rowCount: rows.length };
    }
    // Доменное чтение row с generation predicate.
    if (s.startsWith('SELECT id, video_url, thumbnail_url, source_image_url, audio_url FROM video_jobs')) {
      const [jobId, userId, genId] = params as [string, string, string];
      if (!this.isCurrentDeletion(String(userId), String(genId))) return { rows: [], rowCount: 0 };
      const row = this.videoJobs.find((r) => r.id === jobId && r.user_id === userId);
      return row
        ? {
          rows: [{
            id: row.id,
            video_url: row.video_url ?? null,
            thumbnail_url: row.thumbnail_url ?? null,
            source_image_url: row.source_image_url ?? null,
            audio_url: row.audio_url ?? null,
          }],
          rowCount: 1,
        }
        : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('SELECT 1 FROM user_id')) {
      const [userId, genId] = params as [string, string];
      const ok = !this.failGenRecheck && this.isCurrentDeletion(String(userId), String(genId));
      return ok ? { rows: [{ n: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('DELETE FROM video_jobs')) {
      const [jobId, userId, genId] = params as [string, string, string];
      if (!this.isCurrentDeletion(String(userId), String(genId))) return { rows: [], rowCount: 0 };
      const before = this.videoJobs.length;
      this.videoJobs = this.videoJobs.filter((r) => !(r.id === jobId && r.user_id === userId));
      const deleted = before - this.videoJobs.length;
      this.calls.push('db.deleteVideoJob');
      return { rows: [], rowCount: deleted };
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

function makeVeo() {
  // Проводной клиент провайдера: никаких cancel/delete методов у Veo нет и
  // вызываться из deletion-пути они не должны.
  return {
    isConfigured: jest.fn(() => false),
    cancel: jest.fn(),
    delete: jest.fn(),
    deleteInteraction: jest.fn(),
    startExtend: jest.fn(),
  };
}

function makeHarness(opts: { withStorage?: boolean } = {}) {
  const db = new FakeVideoDb();
  db.users.set(USER, { state: 'deleted', deletionId });
  const storage = makeStorage(db.calls);
  const veo = makeVeo();
  const svc = new VideoService(
    db as any,
    veo as any,
    {} as any,
    undefined,
    opts.withStorage === false ? undefined : (storage as any),
  );
  const registry = new AccountDeletionRegistry();
  const adapter = new VideoAccountDeletionAdapter(svc, registry);
  const assertCurrent = jest.fn(async () => undefined);
  const ctx: DeletionExecution & { assertCurrent: jest.Mock } = { db, assertCurrent };
  return { db, storage, veo, svc, registry, adapter, ctx };
}

function purgeJob(payload: Record<string, unknown>, overrides: Partial<DeletionJobRow> = {}): DeletionJobRow {
  return {
    id: 'job-video-1',
    deletionId,
    userId: USER,
    resourceType: 'video-job.purge',
    resourceKey: 'video-1',
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

function seedRow(db: FakeVideoDb, overrides: Partial<VideoRow> = {}): VideoRow {
  const row: VideoRow = {
    id: 'video-1',
    user_id: USER,
    kling_task_id: 'interaction-1',
    video_url: `${BACKEND}/static/videos/video-1.mp4`,
    thumbnail_url: `${MINIO_BASE}/${VIDEO_BUCKET}/videos/video-1.jpg`,
    source_image_url: `${MINIO_BASE}/${VIDEO_BUCKET}/video-uploads/${USER}/1700000000000-src.jpg`,
    audio_url: null,
    ...overrides,
  };
  db.videoJobs.push(row);
  return row;
}

describe('discoverVideoDeletion — video-job.purge + безопасный skip провайдера (Task 12)', () => {
  it('job по строке удалённого поколения, payload — только videoJobId; interaction ID → skip', async () => {
    const { db, storage, veo } = makeHarness();
    seedRow(db, { id: 'video-1' });
    seedRow(db, { id: 'video-2', kling_task_id: null });
    db.videoJobs.push({ id: 'video-3', user_id: 'u-other' });

    const plan = await discoverVideoDeletion({ db, account, origin: 'explicit' });

    expect(plan.jobs).toHaveLength(2);
    expect(plan.jobs[0]).toEqual({
      resourceType: 'video-job.purge',
      resourceKey: 'video-1',
      phase: 'purge',
      payload: { videoJobId: 'video-1' },
    });
    // Omni interaction ID — не deletable файл: один безопасный skip на план,
    // никакого выдуманного cancel/delete API провайдера.
    expect(plan.skips).toEqual([
      { resourceType: 'video.provider', reason: 'unsupported_external' },
    ]);
    const json = JSON.stringify(plan);
    expect(json).not.toContain(CANARY);
    expect(json).not.toContain(USER);
    expect(json).not.toContain('video-uploads');
    expect(json).not.toContain('interaction-1');
    for (const job of plan.jobs) expect(() => safeDeletionJobSnapshot(job, USER)).not.toThrow();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
    expect(veo.cancel).not.toHaveBeenCalled();
    expect(veo.delete).not.toHaveBeenCalled();
    expect(veo.deleteInteraction).not.toHaveBeenCalled();
  });

  it('без kling_task_id — skip нет', async () => {
    const { db } = makeHarness();
    seedRow(db, { id: 'video-2', kling_task_id: null });

    const plan = await discoverVideoDeletion({ db, account, origin: 'explicit' });

    expect(plan.jobs).toHaveLength(1);
    expect(plan.skips).toEqual([]);
  });

  it('keyset-пагинация: страницы читаются до пустой', async () => {
    const { db } = makeHarness();
    for (let i = 1; i <= 5; i += 1) seedRow(db, { id: `video-${i}`, kling_task_id: null });

    const plan = await discoverVideoDeletion({ db, account, origin: 'explicit', pageSize: 2 });

    expect(plan.jobs).toHaveLength(5);
    const pageQueries = db.queries.filter((q) => q.sql.startsWith('SELECT v.id, v.kling_task_id FROM video_jobs v'));
    expect(pageQueries.length).toBeGreaterThanOrEqual(3);
  });

  it('reactivation — план пустой', async () => {
    const { db } = makeHarness();
    seedRow(db);
    db.users.set(USER, { state: 'active', deletionId: null });

    const plan = await discoverVideoDeletion({ db, account, origin: 'explicit' });

    expect(plan).toEqual({ jobs: [], skips: [] });
  });
});

describe('VideoAccountDeletionAdapter.execute — strict purge (Task 12)', () => {
  let unlinkSpy: jest.SpyInstance;
  let rmSpy: jest.SpyInstance;

  beforeEach(() => {
    unlinkSpy = jest.spyOn(fs.promises, 'unlink').mockImplementation((async () => undefined) as any);
    rmSpy = jest.spyOn(fs.promises, 'rm').mockImplementation((async () => undefined) as any);
  });

  afterEach(() => {
    unlinkSpy.mockRestore();
    rmSpy.mockRestore();
  });

  it('MinIO failure не удаляет video row и technical IDs', async () => {
    const { db, storage, adapter, ctx } = makeHarness();
    seedRow(db);
    const videoJob = purgeJob({ videoJobId: 'video-1' });
    storage.delete.mockRejectedValue({ code: 'ETIMEDOUT' });

    await expect(adapter.execute(videoJob, ctx)).rejects.toMatchObject({ kind: 'timeout' });
    expect(db.videoJobs[0].id).toBe('video-1');
    expect(db.videoJobs[0].kling_task_id).toBe('interaction-1');
    expect(videoJob.payload).toEqual({ videoJobId: 'video-1' });
    expect(db.calls).not.toContain('db.deleteVideoJob');
  });

  it('owned объекты (MinIO + local final MP4/JPG + _veoconcat) удаляются до row', async () => {
    const { db, storage, adapter, ctx } = makeHarness();
    seedRow(db);

    await adapter.execute(purgeJob({ videoJobId: 'video-1' }), ctx);

    // MinIO: производные ключи + video-uploads из СОХРАНЁННОЙ строки.
    const minioKeys = storage.deleteConfirmed.mock.calls.map((c) => c[0]);
    expect(minioKeys).toEqual(expect.arrayContaining([
      { bucket: VIDEO_BUCKET, key: 'videos/video-1.mp4' },
      { bucket: VIDEO_BUCKET, key: 'videos/video-1.jpg' },
      { bucket: VIDEO_BUCKET, key: `video-uploads/${USER}/1700000000000-src.jpg` },
    ]));
    // Дедуп: thumbnail_url указывает на тот же videos/video-1.jpg — один вызов.
    expect(minioKeys.filter((k) => k.key === 'videos/video-1.jpg')).toHaveLength(1);
    // Локальные финалы и staging — через checked own paths.
    expect(unlinkSpy).toHaveBeenCalledWith(path.join(publicDir, 'videos', 'video-1.mp4'));
    expect(unlinkSpy).toHaveBeenCalledWith(path.join(publicDir, 'videos', 'video-1.jpg'));
    expect(rmSpy).toHaveBeenCalledWith(
      path.join(publicDir, 'videos', '_veoconcat', 'video-1'),
      expect.objectContaining({ recursive: true, force: true }),
    );
    // Порядок: все объекты раньше удаления row (журнал вместо toHaveBeenCalledBefore).
    const rowAt = db.calls.indexOf('db.deleteVideoJob');
    expect(rowAt).toBeGreaterThanOrEqual(0);
    const objectEntries = db.calls.filter((c) => c.startsWith('storage.delete:'));
    expect(objectEntries.length).toBeGreaterThanOrEqual(3);
    expect(db.calls.indexOf(objectEntries[objectEntries.length - 1])).toBeLessThan(rowAt);
    expect(db.videoJobs).toHaveLength(0);
    // Payload не содержит ни userId, ни путей из строки.
    const job = purgeJob({ videoJobId: 'video-1' });
    expect(JSON.stringify(job.payload)).not.toContain(USER);
    expect(JSON.stringify(job.payload)).not.toContain('video-uploads');
  });

  it('ключи чужих бакетов и произвольные внешние URL из row не вычисляются и не удаляются', async () => {
    const { db, storage, adapter, ctx } = makeHarness();
    seedRow(db, {
      source_image_url: `${MINIO_BASE}/linkeon-assets/images/foreign.png`,
      video_url: 'https://provider.example/v.mp4?sig=1',
      thumbnail_url: null,
      audio_url: 'https://cdn.example/a.mp3',
    });

    await adapter.execute(purgeJob({ videoJobId: 'video-1' }), ctx);

    for (const call of storage.deleteConfirmed.mock.calls) {
      expect(call[0].bucket).toBe(VIDEO_BUCKET);
      expect(call[0].key.startsWith('videos/')).toBe(true);
    }
    expect(unlinkSpy).not.toHaveBeenCalledWith(expect.stringContaining('provider'));
    expect(db.videoJobs).toHaveLength(0);
  });

  it('escape в videoJobId — retry db, fs и MinIO не вызываются', async () => {
    const { db, storage, adapter, ctx } = makeHarness();
    seedRow(db);

    await expect(adapter.execute(purgeJob({ videoJobId: '../../etc' }), ctx))
      .rejects.toMatchObject({ kind: 'db' });
    expect(unlinkSpy).not.toHaveBeenCalled();
    expect(rmSpy).not.toHaveBeenCalled();
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
    expect(db.videoJobs).toHaveLength(1);
  });

  it('escape в /static video_url — ownStaticPath reject: retry, row остаётся', async () => {
    const { db, adapter, ctx } = makeHarness();
    seedRow(db, { video_url: `${BACKEND}/static/videos/..%2f..%2fetc%2fpasswd` });

    await expect(adapter.execute(purgeJob({ videoJobId: 'video-1' }), ctx))
      .rejects.toBeInstanceOf(DeletionRetryError);
    expect(db.videoJobs).toHaveLength(1);
  });

  it('объекта MinIO уже нет (NotFound) — подтверждённое отсутствие, purge продолжается', async () => {
    const { db, storage, adapter, ctx } = makeHarness();
    seedRow(db);
    storage.delete.mockRejectedValue(Object.assign(new Error('gone'), { name: 'NoSuchKey' }));

    await adapter.execute(purgeJob({ videoJobId: 'video-1' }), ctx);

    expect(db.videoJobs).toHaveLength(0);
  });

  it('локального файла нет (ENOENT) — подтверждённое отсутствие, purge продолжается', async () => {
    const { db, adapter, ctx } = makeHarness();
    seedRow(db);
    unlinkSpy.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));

    await adapter.execute(purgeJob({ videoJobId: 'video-1' }), ctx);

    expect(db.videoJobs).toHaveLength(0);
  });

  it('локальная ошибка доступа (EPERM) — retry permission, row остаётся', async () => {
    const { db, adapter, ctx } = makeHarness();
    seedRow(db);
    unlinkSpy.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EPERM' }));

    await expect(adapter.execute(purgeJob({ videoJobId: 'video-1' }), ctx))
      .rejects.toMatchObject({ kind: 'permission' });
    expect(db.videoJobs).toHaveLength(1);
  });

  it('нет StorageService при owned MinIO-объекте — fail-closed retry external_unknown', async () => {
    const { db, adapter, ctx } = makeHarness({ withStorage: false });
    seedRow(db);

    await expect(adapter.execute(purgeJob({ videoJobId: 'video-1' }), ctx))
      .rejects.toMatchObject({ kind: 'external_unknown' });
    expect(db.videoJobs).toHaveLength(1);
  });

  it('повторный вызов при отсутствии row — success', async () => {
    const { db, storage, adapter, ctx } = makeHarness();

    await adapter.execute(purgeJob({ videoJobId: 'video-1' }), ctx);

    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
    expect(db.queries.some((q) => q.sql.startsWith('DELETE FROM video_jobs'))).toBe(false);
  });

  it('reactivation между объектами и row — DeletionCancelledError, row остаётся', async () => {
    const { db, adapter, ctx } = makeHarness();
    seedRow(db);
    db.failGenRecheck = true;

    await expect(adapter.execute(purgeJob({ videoJobId: 'video-1' }), ctx))
      .rejects.toBeInstanceOf(DeletionCancelledError);
    expect(db.videoJobs).toHaveLength(1);
  });

  it('чужой resourceType — отказ', async () => {
    const { adapter, ctx } = makeHarness();
    const job = { ...purgeJob({ videoJobId: 'video-1' }), resourceType: 'image.purge' as const };

    await expect(adapter.execute(job, ctx)).rejects.toThrow('unsupported_deletion_resource');
  });

  it('assertCurrent зовётся до чтения строк и после внешних операций', async () => {
    const { adapter, ctx } = makeHarness();

    await adapter.execute(purgeJob({ videoJobId: 'video-1' }), ctx);

    expect(ctx.assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('wiring video-job.purge (Task 12)', () => {
  it('adapter регистрирует video-job.purge, VideoModule его провайдит', () => {
    const registry = { register: jest.fn() } as any;
    const adapter = new VideoAccountDeletionAdapter({} as any, registry);
    expect(adapter.resourceTypes).toEqual(['video-job.purge']);
    adapter.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(adapter);

    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, VideoModule) ?? []).flat(Infinity);
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, VideoModule) ?? [];
    expect(imports.filter((item: unknown) => item === AccountDeletionModule)).toHaveLength(1);
    expect(providers.filter((item: unknown) => item === VideoAccountDeletionAdapter)).toHaveLength(1);
  });

  it('catalog содержит discoverVideoDeletion', () => {
    expect(DELETION_DISCOVERERS).toContain(discoverVideoDeletion);
  });
});
