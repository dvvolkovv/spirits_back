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
import { MiscModule } from './misc.module';
import { MiscService } from './misc.service';
import {
  discoverImageDeletion,
  ImageAccountDeletionAdapter,
} from './image-account-deletion.adapter';

/**
 * Task 12 — generated images при удалении аккаунта.
 *
 * Каноническая строка — generated_images: она переживает немедленное удаление
 * истории чата, поэтому image.purge планируется по строке и чистит её объекты
 * СТРОГО: каждый owned MinIO/static/legacy-Yandex объект удаляется с await
 * (никакого allSettled-подавления), и только затем в transaction удаляется
 * row. В payload живёт один технический imageId — prompt (личный текст) не
 * покидает базу. Легаси Yandex S3 удаляется своим сконфигурированным
 * S3-клиентом strict, не MinIO.
 */

const MINIO_BASE = 'https://minio.test';
const BACKEND = 'https://api.test';
const ASSETS_BUCKET = 'linkeon-assets';
const CANARY = 'ЛИЧНЫЙ-ТЕКСТ';
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
  process.env.AWS_ENDPOINT = 'https://storage.yandexcloud.net';
  delete process.env.AWS_S3_BUCKET;
  publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-purge-'));
  process.env.PUBLIC_DIR = publicDir;
});

interface ImageRow {
  id: number;
  user_id: string;
  prompt: string;
  image_url: string;
}

/**
 * Фейковая БД: повторяет семантику SQL доменного метода (чтение row с
 * generation predicate, транзакция BEGIN → re-check generation → DELETE →
 * COMMIT). Настоящий SQL исполняется в image-account-deletion.pg.spec.ts.
 * Журнал calls — общий с фейковым storage: порядок «объект до row»
 * проверяется по нему (эквивалент toHaveBeenCalledBefore).
 */
class FakeImageDb {
  readonly users = new Map<string, { state: string; deletionId: string | null }>();
  generatedImages: ImageRow[] = [];
  readonly queries: Array<{ sql: string; params: any[] }> = [];
  /** Общий журнал вызовов db+storage (порядок операций). */
  readonly calls: string[] = [];
  /** true — generation re-check внутри transaction возвращает пусто. */
  failGenRecheck = false;

  async query(sql: string, params: any[] = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    this.queries.push({ sql: s, params });

    if (/^BEGIN/i.test(s) || /^COMMIT/i.test(s) || /^ROLLBACK/i.test(s)) {
      return { rows: [], rowCount: 0 };
    }
    // Discovery: keyset-страницы id'шек удалённого поколения.
    if (s.startsWith('SELECT g.id FROM generated_images g')) {
      const [userId, lastId, genId, pageSize] = params as [string, number, string, number];
      if (!this.isCurrentDeletion(String(userId), String(genId))) return { rows: [], rowCount: 0 };
      const rows = this.generatedImages
        .filter((r) => r.user_id === userId && r.id > Number(lastId))
        .sort((a, b) => a.id - b.id)
        .slice(0, Number(pageSize))
        .map((r) => ({ id: r.id }));
      return { rows, rowCount: rows.length };
    }
    // Доменное чтение row с generation predicate.
    if (s.startsWith('SELECT id, image_url FROM generated_images')) {
      const [imageId, userId, genId] = params as [number, string, string];
      if (!this.isCurrentDeletion(String(userId), String(genId))) return { rows: [], rowCount: 0 };
      const row = this.generatedImages.find((r) => r.id === Number(imageId) && r.user_id === userId);
      return row ? { rows: [{ id: row.id, image_url: row.image_url }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    // Generation re-check внутри transaction.
    if (s.startsWith('SELECT 1 FROM user_id')) {
      const [userId, genId] = params as [string, string];
      const ok = !this.failGenRecheck && this.isCurrentDeletion(String(userId), String(genId));
      return ok ? { rows: [{ n: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('DELETE FROM generated_images')) {
      const [imageId, userId, genId] = params as [number, string, string];
      if (!this.isCurrentDeletion(String(userId), String(genId))) return { rows: [], rowCount: 0 };
      const before = this.generatedImages.length;
      this.generatedImages = this.generatedImages.filter(
        (r) => !(r.id === Number(imageId) && r.user_id === userId),
      );
      const deleted = before - this.generatedImages.length;
      this.calls.push('db.deleteGeneratedImage');
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

type Storage = ReturnType<typeof makeStorage>;

function makeHarness() {
  const db = new FakeImageDb();
  db.users.set(USER, { state: 'deleted', deletionId });
  const storage = makeStorage(db.calls);
  const svc = new MiscService(null as any, db as any, storage as any, null as any);
  // Легаси Yandex S3-клиент сервиса — под фейк (DeleteObjectCommand strict).
  const legacyS3 = { send: jest.fn(async (_cmd: any) => ({})) };
  (svc as any).s3 = legacyS3;
  const registry = new AccountDeletionRegistry();
  const adapter = new ImageAccountDeletionAdapter(svc, registry);
  const assertCurrent = jest.fn(async () => undefined);
  const ctx: DeletionExecution & { assertCurrent: jest.Mock } = { db, assertCurrent };
  return { db, storage, svc, legacyS3, registry, adapter, ctx };
}

function purgeJob(payload: Record<string, unknown>, overrides: Partial<DeletionJobRow> = {}): DeletionJobRow {
  return {
    id: 'job-image-1',
    deletionId,
    userId: USER,
    resourceType: 'image.purge',
    resourceKey: '7',
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

function seedRow(db: FakeImageDb, overrides: Partial<ImageRow> = {}): ImageRow {
  const row: ImageRow = {
    id: 7,
    user_id: USER,
    prompt: CANARY,
    image_url: `${MINIO_BASE}/${ASSETS_BUCKET}/images/1700000000000-abc123.png`,
    ...overrides,
  };
  db.generatedImages.push(row);
  return row;
}

describe('discoverImageDeletion — image.purge по каноническим строкам (Task 12)', () => {
  it('на каждую строку удалённого поколения — job с одним техническим imageId', async () => {
    const { db, storage } = makeHarness();
    seedRow(db, { id: 7 });
    seedRow(db, { id: 8, image_url: `${BACKEND}/static/generated/b.png` });
    db.generatedImages.push({ id: 9, user_id: 'u-other', prompt: 'чужое', image_url: 'https://x/y.png' });

    const plan = await discoverImageDeletion({ db, account, origin: 'explicit' });

    expect(plan.jobs).toHaveLength(2);
    expect(plan.jobs[0]).toEqual({
      resourceType: 'image.purge',
      resourceKey: '7',
      phase: 'purge',
      payload: { imageId: 7 },
    });
    expect(plan.jobs[1].payload).toEqual({ imageId: 8 });
    expect(plan.skips).toEqual([]);
    const json = JSON.stringify(plan.jobs);
    expect(json).not.toContain(CANARY);
    expect(json).not.toContain(USER);
    expect(json).not.toContain('minio.test');
    expect(json).not.toContain('api.test');
    // Каждый job проходит fail-closed sanitizer плана.
    for (const job of plan.jobs) expect(() => safeDeletionJobSnapshot(job, USER)).not.toThrow();
    // Discovery ничего не удаляет.
    expect(storage.delete).not.toHaveBeenCalled();
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
  });

  it('keyset-пагинация: страницы читаются до пустой', async () => {
    const { db } = makeHarness();
    for (let i = 1; i <= 5; i += 1) seedRow(db, { id: i });

    const plan = await discoverImageDeletion({ db, account, origin: 'explicit', pageSize: 2 });

    expect(plan.jobs).toHaveLength(5);
    const pageQueries = db.queries.filter((q) => q.sql.startsWith('SELECT g.id FROM generated_images g'));
    // 5 строк по 2 + пустая замыкающая страница.
    expect(pageQueries.length).toBeGreaterThanOrEqual(3);
  });

  it('reactivation (поколение не совпало) — план пустой', async () => {
    const { db } = makeHarness();
    seedRow(db);
    db.users.set(USER, { state: 'active', deletionId: null });

    const plan = await discoverImageDeletion({ db, account, origin: 'explicit' });

    expect(plan).toEqual({ jobs: [], skips: [] });
  });
});

describe('ImageAccountDeletionAdapter.execute — strict purge (Task 12)', () => {
  let unlinkSpy: jest.SpyInstance;

  beforeEach(() => {
    unlinkSpy = jest.spyOn(fs.promises, 'unlink').mockImplementation((async (p: any) => {
      // Реального файла в unit-спеке нет — считаем успехом, если путь legit.
      void p;
    }) as any);
  });

  afterEach(() => {
    unlinkSpy.mockRestore();
  });

  it('generated image: объект удалён до row, prompt не сохраняется в job', async () => {
    const { db, storage, adapter, ctx } = makeHarness();
    const row = seedRow(db);
    const job = purgeJob({ imageId: row.id });

    await adapter.execute(job, ctx);

    const objectAt = db.calls.indexOf(`storage.delete:${ASSETS_BUCKET}/images/1700000000000-abc123.png`);
    const rowAt = db.calls.indexOf('db.deleteGeneratedImage');
    expect(objectAt).toBeGreaterThanOrEqual(0);
    expect(rowAt).toBeGreaterThanOrEqual(0);
    // toHaveBeenCalledBefore — не базовый матчер jest: порядок из общего журнала.
    expect(objectAt).toBeLessThan(rowAt);
    expect(storage.deleteConfirmed).toHaveBeenCalledWith({
      bucket: ASSETS_BUCKET,
      key: 'images/1700000000000-abc123.png',
    });
    expect(db.generatedImages).toHaveLength(0);
    expect(JSON.stringify(job.payload)).not.toContain(CANARY);
    expect(ctx.assertCurrent).toHaveBeenCalled();
  });

  it('MinIO-сбой: row остаётся, ошибка — retry timeout (не allSettled-подавление)', async () => {
    const { db, storage, adapter, ctx } = makeHarness();
    seedRow(db);
    storage.delete.mockRejectedValue({ code: 'ETIMEDOUT' });

    await expect(adapter.execute(purgeJob({ imageId: 7 }), ctx))
      .rejects.toMatchObject({ kind: 'timeout' });
    expect(db.generatedImages).toHaveLength(1);
    expect(db.calls).not.toContain('db.deleteGeneratedImage');
  });

  it('объекта уже нет (NotFound) — подтверждённое отсутствие, row удаляется', async () => {
    const { db, storage, adapter, ctx } = makeHarness();
    seedRow(db);
    storage.delete.mockRejectedValue(Object.assign(new Error('gone'), { name: 'NoSuchKey' }));

    await adapter.execute(purgeJob({ imageId: 7 }), ctx);

    expect(db.generatedImages).toHaveLength(0);
  });

  it('legacy Yandex image: свой configured S3 strict delete, не MinIO', async () => {
    const { db, storage, legacyS3, adapter, ctx } = makeHarness();
    seedRow(db, {
      image_url: 'https://storage.yandexcloud.net/linkeon.io/images/1600000000000-xyz.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=secret%2F20260101',
    });

    await adapter.execute(purgeJob({ imageId: 7 }), ctx);

    expect(legacyS3.send).toHaveBeenCalledTimes(1);
    const cmd = legacyS3.send.mock.calls[0][0];
    expect(cmd.input).toMatchObject({ Bucket: 'linkeon.io', Key: 'images/1600000000000-xyz.jpg' });
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
    expect(db.generatedImages).toHaveLength(0);
  });

  it('legacy Yandex strict: сетевая ошибка — retry, row остаётся', async () => {
    const { db, legacyS3, adapter, ctx } = makeHarness();
    seedRow(db, { image_url: 'https://storage.yandexcloud.net/linkeon.io/images/a.jpg' });
    legacyS3.send.mockRejectedValue({ code: 'ETIMEDOUT' });

    await expect(adapter.execute(purgeJob({ imageId: 7 }), ctx))
      .rejects.toMatchObject({ kind: 'timeout' });
    expect(db.generatedImages).toHaveLength(1);
  });

  it('legacy Yandex: NoSuchKey — подтверждённое отсутствие, row удаляется', async () => {
    const { db, legacyS3, adapter, ctx } = makeHarness();
    seedRow(db, { image_url: 'https://storage.yandexcloud.net/linkeon.io/images/a.jpg' });
    legacyS3.send.mockRejectedValue(Object.assign(new Error('gone'), { name: 'NoSuchKey' }));

    await adapter.execute(purgeJob({ imageId: 7 }), ctx);

    expect(db.generatedImages).toHaveLength(0);
  });

  it('локальный /static: файл удаляется через checked own path до row', async () => {
    const { db, adapter, ctx } = makeHarness();
    seedRow(db, { image_url: `${BACKEND}/static/generated/pic.png` });

    await adapter.execute(purgeJob({ imageId: 7 }), ctx);

    expect(unlinkSpy).toHaveBeenCalledWith(path.join(publicDir, 'generated', 'pic.png'));
    expect(db.generatedImages).toHaveLength(0);
  });

  it('escape в /static URL (..%2f) — ownStaticPath reject: retry, файл и row не тронуты', async () => {
    const { db, adapter, ctx } = makeHarness();
    seedRow(db, { image_url: `${BACKEND}/static/generated/..%2f..%2fetc%2fpasswd` });

    await expect(adapter.execute(purgeJob({ imageId: 7 }), ctx))
      .rejects.toBeInstanceOf(DeletionRetryError);
    expect(unlinkSpy).not.toHaveBeenCalled();
    expect(db.generatedImages).toHaveLength(1);
  });

  it('чужой/внешний URL — объект не трогаем, row удаляется', async () => {
    const { db, storage, adapter, ctx } = makeHarness();
    seedRow(db, { image_url: 'https://cdn.example.com/pic.png' });

    await adapter.execute(purgeJob({ imageId: 7 }), ctx);

    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
    expect(unlinkSpy).not.toHaveBeenCalled();
    expect(db.generatedImages).toHaveLength(0);
  });

  it('повторный вызов при отсутствии row — success', async () => {
    const { db, storage, adapter, ctx } = makeHarness();

    await adapter.execute(purgeJob({ imageId: 7 }), ctx);

    expect(db.generatedImages).toHaveLength(0);
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
    expect(db.queries.some((q) => q.sql.startsWith('DELETE FROM generated_images'))).toBe(false);
  });

  it('reactivation между объектом и row — DeletionCancelledError, row остаётся', async () => {
    const { db, adapter, ctx } = makeHarness();
    seedRow(db);
    db.failGenRecheck = true;

    await expect(adapter.execute(purgeJob({ imageId: 7 }), ctx))
      .rejects.toBeInstanceOf(DeletionCancelledError);
    expect(db.generatedImages).toHaveLength(1);
  });

  it('payload без целого imageId — retry db, сервис не вызывается', async () => {
    const { db, svc, adapter, ctx } = makeHarness();
    seedRow(db);
    const spy = jest.spyOn(svc, 'deleteGeneratedImageForDeletion');

    await expect(adapter.execute(purgeJob({ imageId: 'abc' }), ctx))
      .rejects.toMatchObject({ kind: 'db' });
    expect(spy).not.toHaveBeenCalled();
    expect(db.generatedImages).toHaveLength(1);
  });

  it('чужой resourceType — отказ', async () => {
    const { adapter, ctx } = makeHarness();
    const job = { ...purgeJob({ imageId: 7 }), resourceType: 'video-job.purge' as const };

    await expect(adapter.execute(job, ctx)).rejects.toThrow('unsupported_deletion_resource');
  });

  it('assertCurrent зовётся до чтения строк и после внешних операций', async () => {
    const { adapter, ctx } = makeHarness();

    await adapter.execute(purgeJob({ imageId: 7 }), ctx);

    expect(ctx.assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('wiring image.purge (Task 12)', () => {
  it('adapter регистрирует image.purge, MiscModule его провайдит', () => {
    const registry = { register: jest.fn() } as any;
    const svc = {} as any;
    const adapter = new ImageAccountDeletionAdapter(svc, registry);
    expect(adapter.resourceTypes).toEqual(['image.purge']);
    adapter.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(adapter);

    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, MiscModule) ?? []).flat(Infinity);
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, MiscModule) ?? [];
    expect(imports.filter((item: unknown) => item === AccountDeletionModule)).toHaveLength(1);
    expect(providers.filter((item: unknown) => item === ImageAccountDeletionAdapter)).toHaveLength(1);
  });

  it('catalog содержит discoverImageDeletion', () => {
    expect(DELETION_DISCOVERERS).toContain(discoverImageDeletion);
  });
});
