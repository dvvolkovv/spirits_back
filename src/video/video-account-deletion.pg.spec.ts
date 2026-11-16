import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import type { DeletionJobRow } from '../account-deletion/account-deletion.types';
import { VideoService } from './video.service';
import {
  discoverVideoDeletion,
  VideoAccountDeletionAdapter,
} from './video-account-deletion.adapter';

/**
 * Task 12 против живого Postgres: discovery SQL (keyset по uuid + generation
 * predicate) и строгий доменный метод deleteVideoForDeletion, включая
 * FK-cascade tg_bot_video_jobs (TG delivery row удаляется вместе с video job).
 * Схема video_jobs/tg_bot_video_jobs — из РЕАЛЬНЫХ миграций.
 */

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

const USER = 'u-deleted';
const DELETION_ID = randomUUID();
const OLD_DELETION_ID = randomUUID();

function makeStorage(log: Array<{ bucket: string; key: string }>) {
  return {
    deleteConfirmed: async (input: { bucket: string; key: string }) => {
      log.push(input);
      return 'deleted' as const;
    },
    delete: async () => undefined,
    publicUrl: (bucket: string, key: string) => `https://minio.test/${bucket}/${key}`,
  };
}

maybe('video-job.purge против живого Postgres (Task 12)', () => {
  jest.setTimeout(30_000);

  let pool: Pool;
  let publicDir: string;
  let prevPublicDir: string | undefined;
  let prevBackendUrl: string | undefined;
  let prevMinioPublicUrl: string | undefined;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 4 });
    await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', '001_video_jobs.sql'), 'utf8'));
    // Минимальный FK-таргет для tg_bot_video_jobs.config_id (реальная схема в
    // 001_tg_bot_schema.sql; здесь важен только PK).
    await pool.query(`CREATE TABLE IF NOT EXISTS tg_bot_configs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_user_id text NOT NULL
    )`);
    await pool.query(fs.readFileSync(
      path.join(__dirname, '..', 'tg-bot', 'migrations', '003_tg_bot_video_delivery.sql'),
      'utf8',
    ));
    await pool.query(`CREATE TABLE IF NOT EXISTS user_id (
      internal_id text PRIMARY KEY,
      state text,
      deleted_at timestamptz,
      deletion_id uuid
    )`);
    publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-purge-pg-'));
    prevPublicDir = process.env.PUBLIC_DIR;
    prevBackendUrl = process.env.BACKEND_URL;
    prevMinioPublicUrl = process.env.MINIO_PUBLIC_URL;
    process.env.PUBLIC_DIR = publicDir;
    process.env.BACKEND_URL = 'https://api.test';
    // Реализация матчит MinIO-URL строк по префиксу s3PublicUrl (из env).
    process.env.MINIO_PUBLIC_URL = 'https://minio.test';
  });

  afterAll(async () => {
    if (publicDir) fs.rmSync(publicDir, { recursive: true, force: true });
    if (prevPublicDir === undefined) delete process.env.PUBLIC_DIR;
    else process.env.PUBLIC_DIR = prevPublicDir;
    if (prevBackendUrl === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = prevBackendUrl;
    if (prevMinioPublicUrl === undefined) delete process.env.MINIO_PUBLIC_URL;
    else process.env.MINIO_PUBLIC_URL = prevMinioPublicUrl;
    await pool?.query('TRUNCATE video_jobs, tg_bot_video_jobs, tg_bot_configs, user_id CASCADE')
      .catch(() => undefined);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE video_jobs, tg_bot_video_jobs, user_id CASCADE');
    await pool.query(
      `INSERT INTO user_id (internal_id, state, deleted_at, deletion_id)
       VALUES ($1, 'deleted', now(), $2)`,
      [USER, DELETION_ID],
    );
  });

  function makeService(storageLog: Array<{ bucket: string; key: string }>) {
    const pgDuck = {
      query: (sql: string, params?: any[]) => pool.query(sql, params),
      getClient: () => pool.connect(),
    };
    return new VideoService(
      pgDuck as any,
      { isConfigured: () => false } as any,
      {} as any,
      undefined,
      makeStorage(storageLog) as any,
    );
  }

  async function insertJob(overrides: Record<string, unknown> = {}): Promise<string> {
    const id = String(overrides.id ?? randomUUID());
    await pool.query(
      `INSERT INTO video_jobs
         (id, user_id, mode, model, quality, duration_sec, prompt, tokens_spent,
          kling_task_id, status, video_url, thumbnail_url, source_image_url)
       VALUES ($1,$2,'veo','veo-3.1','std',8,'ЛИЧНЫЙ-ПРОМПТ',0,$3,'ready',$4,$5,$6)`,
      [
        id,
        String(overrides.user_id ?? USER),
        overrides.kling_task_id ?? 'interaction-1',
        overrides.video_url ?? `https://api.test/static/videos/${id}.mp4`,
        overrides.thumbnail_url ?? `https://minio.test/linkeon-smm-videos/videos/${id}.jpg`,
        overrides.source_image_url ?? `https://minio.test/linkeon-smm-videos/video-uploads/${USER}/1700-src.jpg`,
      ],
    );
    return id;
  }

  it('discovery: keyset по uuid, generation predicate, skip video.provider один на план', async () => {
    const idA = await insertJob({ id: '11111111-1111-4111-8111-111111111111' });
    const idB = await insertJob({ id: '22222222-2222-4222-8222-222222222222', kling_task_id: null });
    await insertJob({ user_id: 'u-other' });

    const plan = await discoverVideoDeletion({
      db: pool,
      account: { userId: USER, deletionId: DELETION_ID, deletedAt: new Date() },
      origin: 'explicit',
      pageSize: 1,
    });

    expect(plan.jobs.map((j) => j.resourceKey)).toEqual([idA, idB]);
    expect(plan.jobs.every((j) => j.resourceType === 'video-job.purge')).toBe(true);
    expect(plan.skips).toEqual([
      { resourceType: 'video.provider', reason: 'unsupported_external' },
    ]);
    expect(JSON.stringify(plan.jobs)).not.toContain('ЛИЧНЫЙ-ПРОМПТ');
  });

  it('discovery: старое поколение (reactivation) — план пустой', async () => {
    await insertJob();
    const plan = await discoverVideoDeletion({
      db: pool,
      account: { userId: USER, deletionId: OLD_DELETION_ID, deletedAt: new Date() },
      origin: 'explicit',
    });
    expect(plan).toEqual({ jobs: [], skips: [] });
  });

  it('deleteVideoForDeletion: объекты, row и TG delivery row (cascade) удалены', async () => {
    const jobId = await insertJob();
    await pool.query(
      `INSERT INTO tg_bot_video_jobs (job_id, tg_chat_id, delivery_status)
       VALUES ($1, 42, 'pending')`,
      [jobId],
    );
    // Реальные локальные файлы: финальный MP4/JPG и staging _veoconcat.
    const videosDir = path.join(publicDir, 'videos');
    fs.mkdirSync(path.join(videosDir, '_veoconcat', jobId), { recursive: true });
    fs.writeFileSync(path.join(videosDir, `${jobId}.mp4`), 'mp4');
    fs.writeFileSync(path.join(videosDir, `${jobId}.jpg`), 'jpg');
    fs.writeFileSync(path.join(videosDir, '_veoconcat', jobId, 'seg_00.mp4'), 'seg');

    const storageLog: Array<{ bucket: string; key: string }> = [];
    const svc = makeService(storageLog);
    await svc.deleteVideoForDeletion(USER, jobId, DELETION_ID);

    const rows = await pool.query('SELECT id FROM video_jobs WHERE id=$1', [jobId]);
    expect(rows.rows).toHaveLength(0);
    // TG delivery row удалён FK-cascade вместе с video job.
    const tg = await pool.query('SELECT job_id FROM tg_bot_video_jobs WHERE job_id=$1', [jobId]);
    expect(tg.rows).toHaveLength(0);
    // MinIO: производные ключи + video-uploads из сохранённой строки.
    expect(storageLog).toEqual(expect.arrayContaining([
      { bucket: 'linkeon-smm-videos', key: `videos/${jobId}.mp4` },
      { bucket: 'linkeon-smm-videos', key: `videos/${jobId}.jpg` },
      { bucket: 'linkeon-smm-videos', key: `video-uploads/${USER}/1700-src.jpg` },
    ]));
    // Локальные файлы исчезли.
    expect(fs.existsSync(path.join(videosDir, `${jobId}.mp4`))).toBe(false);
    expect(fs.existsSync(path.join(videosDir, `${jobId}.jpg`))).toBe(false);
    expect(fs.existsSync(path.join(videosDir, '_veoconcat', jobId))).toBe(false);
  });

  it('старое deletionId (reactivation) — row и TG delivery не тронуты', async () => {
    const jobId = await insertJob();
    await pool.query(
      `INSERT INTO tg_bot_video_jobs (job_id, tg_chat_id) VALUES ($1, 42)`,
      [jobId],
    );
    const storageLog: Array<{ bucket: string; key: string }> = [];
    const svc = makeService(storageLog);

    await svc.deleteVideoForDeletion(USER, jobId, OLD_DELETION_ID);

    const rows = await pool.query('SELECT id FROM video_jobs WHERE id=$1', [jobId]);
    expect(rows.rows).toHaveLength(1);
    const tg = await pool.query('SELECT job_id FROM tg_bot_video_jobs WHERE job_id=$1', [jobId]);
    expect(tg.rows).toHaveLength(1);
    expect(storageLog).toEqual([]);
  });

  it('повторный вызов после purge — success (идемпотентность)', async () => {
    const jobId = await insertJob();
    const storageLog: Array<{ bucket: string; key: string }> = [];
    const svc = makeService(storageLog);

    await svc.deleteVideoForDeletion(USER, jobId, DELETION_ID);
    await expect(svc.deleteVideoForDeletion(USER, jobId, DELETION_ID)).resolves.toBeUndefined();
  });

  it('adapter end-to-end через execute: row удалена', async () => {
    const jobId = await insertJob();
    const storageLog: Array<{ bucket: string; key: string }> = [];
    const svc = makeService(storageLog);
    const adapter = new VideoAccountDeletionAdapter(svc, new AccountDeletionRegistry());
    const job: DeletionJobRow = {
      id: 'job-1',
      deletionId: DELETION_ID,
      userId: USER,
      resourceType: 'video-job.purge',
      resourceKey: jobId,
      phase: 'purge',
      payload: { videoJobId: jobId },
      status: 'running',
      attempts: 1,
      nextAttemptAt: new Date(),
      leaseUntil: new Date(Date.now() + 60_000),
      lastErrorKind: null,
    };

    await adapter.execute(job, {
      db: pool,
      assertCurrent: async () => undefined,
    });

    const rows = await pool.query('SELECT id FROM video_jobs WHERE id=$1', [jobId]);
    expect(rows.rows).toHaveLength(0);
  });
});
