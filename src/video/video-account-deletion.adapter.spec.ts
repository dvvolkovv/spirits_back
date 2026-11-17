import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
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
import { StorageService } from '../common/services/storage.service';
import { VideoModule } from './video.module';
import { VideoService } from './video.service';
import {
  discoverVideoDeletion,
  discoverVideoUploadsDeletion,
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
// Гигиена: env восстанавливается по образцу pg-спеков — спек не должен
// оставлять BACKEND_URL/MINIO_* соседним файлам в одном воркере jest.
const ENV_KEYS = ['BACKEND_URL', 'MINIO_BUCKET_VIDEOS', 'MINIO_PUBLIC_URL', 'PUBLIC_DIR'] as const;
const prevEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  process.env.BACKEND_URL = BACKEND;
  process.env.MINIO_BUCKET_VIDEOS = VIDEO_BUCKET;
  // Реализация матчит MinIO-URL строк по префиксу s3PublicUrl (из env).
  process.env.MINIO_PUBLIC_URL = MINIO_BASE;
  publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-purge-'));
  process.env.PUBLIC_DIR = publicDir;
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k] as string;
  }
  if (publicDir) fs.rmSync(publicDir, { recursive: true, force: true });
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

// ---------------------------------------------------------------------------
// K4 — личные загрузки video-uploads/<userId>/ без строки video_jobs.
//
// uploadUserAsset кладёт фото в MinIO ДО и независимо от строки задачи:
// фото могло не дойти до задачи, cleanupOldFailedJobs стирает failed-строки,
// не трогая объекты, а 2-е и 3-е референс-фото Veo живут только в
// composed_plan. Purge по строкам их не видит — нужен обход всего префикса.

/** Синтетический телефонный internal_id (публичный репозиторий). */
const PHONE_USER = '79990000501';
/** Префикс-родственник: без завершающего '/' префикс PHONE_USER задел бы его. */
const PHONE_NEIGHBOR = '799900005010';
const OWN_PREFIX = `video-uploads/${PHONE_USER}/`;

/**
 * Фейковый MinIO на уровне S3-транспорта: настоящий StorageService шлёт в
 * него настоящие ListObjectsV2Command/DeleteObjectCommand. Семантика S3:
 * Prefix — буквальный префикс ключа, ключи в лексикографическом порядке,
 * MaxKeys/pageSize режет страницу, IsTruncated + NextContinuationToken
 * (непрозрачный маркер последнего ключа — как у MinIO) ведут на следующую;
 * DeleteObject по отсутствующему ключу — 204, успех.
 */
class FakeMinio {
  private readonly buckets = new Map<string, Set<string>>();
  readonly log: Array<{ op: 'list' | 'delete'; bucket: string; prefix?: string; key?: string; token?: string }> = [];
  pageSize = 1000;
  listError: unknown = null;
  listOverride: ((input: any) => any) | null = null;
  /** Отказ на N-м удалении (сквозной счёт, с 1) — частичный прогон. */
  deleteErrorAt: { n: number; error: unknown } | null = null;
  private deletes = 0;

  put(bucket: string, ...keys: string[]): void {
    const set = this.buckets.get(bucket) ?? new Set<string>();
    for (const key of keys) set.add(key);
    this.buckets.set(bucket, set);
  }

  keys(bucket: string): string[] {
    return [...(this.buckets.get(bucket) ?? [])].sort();
  }

  async send(command: unknown): Promise<any> {
    if (command instanceof ListObjectsV2Command) {
      const input = command.input;
      this.log.push({
        op: 'list',
        bucket: String(input.Bucket),
        prefix: input.Prefix,
        token: input.ContinuationToken,
      });
      if (this.listError) throw this.listError;
      if (this.listOverride) return this.listOverride(input);
      const prefix = input.Prefix ?? '';
      const after = input.ContinuationToken
        ? Buffer.from(input.ContinuationToken, 'base64').toString('utf8')
        : '';
      const limit = Math.min(input.MaxKeys ?? 1000, this.pageSize);
      const matching = this.keys(String(input.Bucket))
        .filter((k) => k.startsWith(prefix) && k > after);
      const page = matching.slice(0, limit);
      const truncated = matching.length > page.length;
      return {
        Contents: page.map((Key) => ({ Key, Size: 1 })),
        KeyCount: page.length,
        IsTruncated: truncated,
        NextContinuationToken: truncated
          ? Buffer.from(page[page.length - 1], 'utf8').toString('base64')
          : undefined,
      };
    }
    if (command instanceof DeleteObjectCommand) {
      const bucket = String(command.input.Bucket);
      const key = String(command.input.Key);
      this.log.push({ op: 'delete', bucket, key });
      this.deletes += 1;
      if (this.deleteErrorAt && this.deleteErrorAt.n === this.deletes) {
        throw this.deleteErrorAt.error;
      }
      this.buckets.get(bucket)?.delete(key);
      return {};
    }
    throw new Error('unexpected S3 command');
  }
}

function makeUploadsHarness(opts: { withStorage?: boolean } = {}) {
  const db = new FakeVideoDb();
  db.users.set(PHONE_USER, { state: 'deleted', deletionId });
  db.users.set(PHONE_NEIGHBOR, { state: 'active', deletionId: null });
  const minio = new FakeMinio();
  // Настоящий StorageService с подменённым транспортом (как synthetic stack):
  // onModuleInit не зовётся — env MinIO спеку не нужен.
  const storage = new StorageService();
  (storage as any).s3 = minio;
  (storage as any).publicBaseUrl = MINIO_BASE;
  const svc = new VideoService(
    db as any,
    makeVeo() as any,
    {} as any,
    undefined,
    opts.withStorage === false ? undefined : storage,
  );
  const registry = new AccountDeletionRegistry();
  const adapter = new VideoAccountDeletionAdapter(svc, registry);
  const assertCurrent = jest.fn(async () => undefined);
  const ctx: DeletionExecution & { assertCurrent: jest.Mock } = { db, assertCurrent };
  return { db, minio, adapter, ctx };
}

function uploadsJob(overrides: Partial<DeletionJobRow> = {}): DeletionJobRow {
  return {
    id: 'job-video-uploads-1',
    deletionId,
    userId: PHONE_USER,
    resourceType: 'video-upload.purge',
    resourceKey: 'video-uploads',
    phase: 'purge',
    payload: {},
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date('2026-12-12T00:00:00Z'),
    leaseUntil: new Date('2026-12-12T01:00:00Z'),
    lastErrorKind: null,
    ...overrides,
  };
}

const ownKey = (name: string) => `${OWN_PREFIX}${name}`;
const ownLeft = (minio: FakeMinio) =>
  minio.keys(VIDEO_BUCKET).filter((k) => k.startsWith(OWN_PREFIX));
const listCalls = (minio: FakeMinio) => minio.log.filter((c) => c.op === 'list');
const deleteCalls = (minio: FakeMinio) => minio.log.filter((c) => c.op === 'delete');

describe('discoverVideoUploadsDeletion — video-upload.purge на аккаунт (K4)', () => {
  it('строк video_jobs нет — задача всё равно одна: статический ключ, пустой payload', async () => {
    const { db } = makeUploadsHarness();

    const plan = await discoverVideoUploadsDeletion({
      db,
      account: { ...account, userId: PHONE_USER },
      origin: 'explicit',
    });

    expect(plan).toEqual({
      jobs: [{
        resourceType: 'video-upload.purge',
        resourceKey: 'video-uploads',
        phase: 'purge',
        payload: {},
      }],
      skips: [],
    });
    // Цель выводится из job.userId при исполнении: ни userId, ни префикса в плане.
    expect(JSON.stringify(plan)).not.toContain(PHONE_USER);
    expect(JSON.stringify(plan)).not.toContain('video-uploads/');
    for (const job of plan.jobs) expect(() => safeDeletionJobSnapshot(job, PHONE_USER)).not.toThrow();
  });

  it('реактивация (поколение не текущее) — план пустой', async () => {
    const { db } = makeUploadsHarness();
    db.users.set(PHONE_USER, { state: 'active', deletionId: null });

    const plan = await discoverVideoUploadsDeletion({
      db,
      account: { ...account, userId: PHONE_USER },
      origin: 'explicit',
    });

    expect(plan).toEqual({ jobs: [], skips: [] });
  });
});

describe('VideoAccountDeletionAdapter.execute — video-upload.purge (K4)', () => {
  it('(а) объекты под video-uploads/<userId>/ без строки video_jobs удаляются', async () => {
    const { db, minio, adapter, ctx } = makeUploadsHarness();
    minio.put(VIDEO_BUCKET, ownKey('1700000000001-a1b2c3.jpg'), ownKey('1700000000002-d4e5f6.png'));
    expect(db.videoJobs).toHaveLength(0);

    await adapter.execute(uploadsJob(), ctx);

    expect(ownLeft(minio)).toEqual([]);
    const lists = listCalls(minio);
    expect(lists.length).toBeGreaterThanOrEqual(1);
    for (const call of lists) {
      expect(call).toMatchObject({ bucket: VIDEO_BUCKET, prefix: OWN_PREFIX });
    }
    expect(deleteCalls(minio).map((c) => `${c.bucket}/${c.key}`).sort()).toEqual([
      `${VIDEO_BUCKET}/${ownKey('1700000000001-a1b2c3.jpg')}`,
      `${VIDEO_BUCKET}/${ownKey('1700000000002-d4e5f6.png')}`,
    ]);
  });

  it('(б) соседний пользователь с id-префиксом, чужие префиксы и бакеты не затронуты', async () => {
    const { minio, adapter, ctx } = makeUploadsHarness();
    const foreign = [
      `video-uploads/${PHONE_NEIGHBOR}/1700000000003-n.jpg`,
      `video-uploads/${PHONE_USER}1/1700000000004-n.jpg`,
      'videos/11111111-1111-4111-8111-111111111111.mp4',
      'shorts/v/video.mp4',
    ];
    minio.put(VIDEO_BUCKET, ownKey('1700000000001-a.jpg'), ...foreign);
    minio.put('linkeon-assets', ownKey('1700000000001-a.jpg'));

    await adapter.execute(uploadsJob(), ctx);

    expect(minio.keys(VIDEO_BUCKET)).toEqual([...foreign].sort());
    expect(minio.keys('linkeon-assets')).toEqual([ownKey('1700000000001-a.jpg')]);
    for (const call of listCalls(minio)) expect(call.prefix).toBe(OWN_PREFIX);
    for (const call of deleteCalls(minio)) {
      expect(call.bucket).toBe(VIDEO_BUCKET);
      expect(call.key!.startsWith(OWN_PREFIX)).toBe(true);
    }
  });

  it('(в) пагинация: больше одной страницы — удалено всё, токен ведёт дальше', async () => {
    const { minio, adapter, ctx } = makeUploadsHarness();
    minio.pageSize = 2;
    const own = [1, 2, 3, 4, 5].map((i) => ownKey(`170000000000${i}-p.jpg`));
    minio.put(VIDEO_BUCKET, ...own, `video-uploads/${PHONE_NEIGHBOR}/1700000000009-n.jpg`);

    await adapter.execute(uploadsJob(), ctx);

    expect(ownLeft(minio)).toEqual([]);
    expect(minio.keys(VIDEO_BUCKET)).toEqual([`video-uploads/${PHONE_NEIGHBOR}/1700000000009-n.jpg`]);
    const lists = listCalls(minio);
    expect(lists.length).toBeGreaterThanOrEqual(3);
    expect(lists[0].token).toBeUndefined();
    for (const call of lists.slice(1)) expect(typeof call.token).toBe('string');
    expect(deleteCalls(minio)).toHaveLength(5);
  });

  it('(в) усечённая страница без токена — retry external_unknown, а не тихий успех', async () => {
    const { minio, adapter, ctx } = makeUploadsHarness();
    minio.put(VIDEO_BUCKET, ownKey('1700000000001-a.jpg'));
    minio.listOverride = () => ({ Contents: [], KeyCount: 0, IsTruncated: true });

    await expect(adapter.execute(uploadsJob(), ctx))
      .rejects.toMatchObject({ kind: 'external_unknown' });
    expect(ownLeft(minio)).toHaveLength(1);
  });

  it('листинг вернул ключ вне префикса — retry external_unknown, удалений нет', async () => {
    const { minio, adapter, ctx } = makeUploadsHarness();
    minio.put(VIDEO_BUCKET, `video-uploads/${PHONE_NEIGHBOR}/1700000000003-n.jpg`);
    minio.listOverride = () => ({
      Contents: [{ Key: `video-uploads/${PHONE_NEIGHBOR}/1700000000003-n.jpg` }],
      KeyCount: 1,
      IsTruncated: false,
    });

    await expect(adapter.execute(uploadsJob(), ctx))
      .rejects.toMatchObject({ kind: 'external_unknown' });
    expect(deleteCalls(minio)).toHaveLength(0);
    expect(minio.keys(VIDEO_BUCKET)).toHaveLength(1);
  });

  it.each([
    ['пустой', ''],
    ['пробел', ' '],
    ['traversal', '../79990000501'],
    ['завершающий слэш', `${PHONE_USER}/`],
    ['слэш внутри', `${PHONE_USER}/..`],
    ['перевод строки', '7999\n0000501'],
    ['NUL', `${PHONE_USER}\u0000`],
    ['ведущая точка', '.79990000501'],
    ['длиннее 128', '7'.repeat(129)],
  ])('(г) неверный userId (%s) — ни одного листинга, retry db', async (_label, badUserId) => {
    const { minio, adapter, ctx } = makeUploadsHarness();
    minio.put(VIDEO_BUCKET, ownKey('1700000000001-a.jpg'), 'videos/x.mp4');

    await expect(adapter.execute(uploadsJob({ userId: badUserId }), ctx))
      .rejects.toMatchObject({ kind: 'db' });
    expect(minio.log).toEqual([]);
    expect(minio.keys(VIDEO_BUCKET)).toHaveLength(2);
  });

  it('(д) повторный прогон после частичного удаления доходит до конца; пусто — успех', async () => {
    const { minio, adapter, ctx } = makeUploadsHarness();
    minio.put(VIDEO_BUCKET, ownKey('1-a.jpg'), ownKey('2-b.jpg'), ownKey('3-c.jpg'));
    minio.deleteErrorAt = { n: 2, error: Object.assign(new Error('socket'), { code: 'ETIMEDOUT' }) };

    await expect(adapter.execute(uploadsJob(), ctx)).rejects.toMatchObject({ kind: 'timeout' });
    expect(ownLeft(minio)).toHaveLength(2);

    await adapter.execute(uploadsJob(), ctx);
    expect(ownLeft(minio)).toEqual([]);

    // Объектов нет — успех без удалений.
    const deletesBefore = deleteCalls(minio).length;
    await expect(adapter.execute(uploadsJob(), ctx)).resolves.toBeUndefined();
    expect(deleteCalls(minio)).toHaveLength(deletesBefore);
  });

  it('ошибка листинга MinIO классифицируется (503 → external_5xx), объекты на месте', async () => {
    const { minio, adapter, ctx } = makeUploadsHarness();
    minio.put(VIDEO_BUCKET, ownKey('1-a.jpg'));
    minio.listError = Object.assign(new Error('unavailable'), {
      name: 'ServiceUnavailable',
      $metadata: { httpStatusCode: 503 },
    });

    await expect(adapter.execute(uploadsJob(), ctx)).rejects.toMatchObject({ kind: 'external_5xx' });
    expect(ownLeft(minio)).toHaveLength(1);
  });

  it('нет StorageService — fail-closed external_unknown, без листинга', async () => {
    const { minio, adapter, ctx } = makeUploadsHarness({ withStorage: false });
    minio.put(VIDEO_BUCKET, ownKey('1-a.jpg'));

    await expect(adapter.execute(uploadsJob(), ctx))
      .rejects.toMatchObject({ kind: 'external_unknown' });
    expect(minio.log).toEqual([]);
  });

  it('реактивация (поколение не текущее) — DeletionCancelledError, без листинга', async () => {
    const { db, minio, adapter, ctx } = makeUploadsHarness();
    db.users.set(PHONE_USER, { state: 'active', deletionId: null });
    minio.put(VIDEO_BUCKET, ownKey('1-a.jpg'));

    await expect(adapter.execute(uploadsJob(), ctx)).rejects.toBeInstanceOf(DeletionCancelledError);
    expect(minio.log).toEqual([]);
    expect(ownLeft(minio)).toHaveLength(1);
  });

  it('assertCurrent — до обхода, перед каждым удалением и после; отмена посреди обхода останавливает', async () => {
    const { minio, adapter, ctx } = makeUploadsHarness();
    minio.put(VIDEO_BUCKET, ownKey('1-a.jpg'), ownKey('2-b.jpg'));

    await adapter.execute(uploadsJob(), ctx);
    expect(ctx.assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(4);

    const second = makeUploadsHarness();
    second.minio.put(VIDEO_BUCKET, ownKey('1-a.jpg'), ownKey('2-b.jpg'), ownKey('3-c.jpg'));
    // Поколение отменено после первого удаления: дальше ни одного объекта.
    second.ctx.assertCurrent.mockImplementation(async () => {
      if (deleteCalls(second.minio).length >= 1) throw new DeletionCancelledError();
    });
    await expect(second.adapter.execute(uploadsJob(), second.ctx))
      .rejects.toBeInstanceOf(DeletionCancelledError);
    expect(deleteCalls(second.minio)).toHaveLength(1);
    expect(ownLeft(second.minio)).toHaveLength(2);
  });
});

describe('wiring video-job.purge (Task 12)', () => {
  it('adapter регистрирует video-job.purge и video-upload.purge (K4), VideoModule его провайдит', () => {
    const registry = { register: jest.fn() } as any;
    const adapter = new VideoAccountDeletionAdapter({} as any, registry);
    expect(adapter.resourceTypes).toEqual(['video-job.purge', 'video-upload.purge']);
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

  it('catalog содержит discoverVideoUploadsDeletion сразу после discoverVideoDeletion (K4)', () => {
    const at = DELETION_DISCOVERERS.indexOf(discoverVideoDeletion);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(DELETION_DISCOVERERS[at + 1]).toBe(discoverVideoUploadsDeletion);
  });
});
