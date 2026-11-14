import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { AvatarService } from './avatar.service';
import { discoverAvatarDeletion } from './avatar-account-deletion.adapter';
import { DeletionCancelledError } from '../account-deletion/account-deletion.safe';

/**
 * Task 13 против живого Postgres: generation gate аватара (единственный SQL
 * доменного метода) и удаление легаси-файла public/avatars/<userId>.jpg.
 * Профиль (profile_data.avatar_url) не читается: целей нет в БД, они
 * вычисляются из userId.
 */

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

const USER = '79000000000';
const DELETION_ID = randomUUID();
const OLD_DELETION_ID = randomUUID();
const MINIO_BASE = 'https://minio.test';
const ASSETS_BUCKET = 'linkeon-assets';

function makeStorage(log: string[]) {
  return {
    deleteConfirmed: async (input: { bucket: string; key: string }) => {
      log.push(`storage.delete:${input.bucket}/${input.key}`);
      return 'deleted' as const;
    },
    delete: async () => undefined,
    publicUrl: (bucket: string, key: string) => `${MINIO_BASE}/${bucket}/${key}`,
  };
}

maybe('avatar.purge против живого Postgres (Task 13)', () => {
  jest.setTimeout(30_000);

  let pool: Pool;
  let publicDir: string;
  let prevPublicDir: string | undefined;
  let prevBackendUrl: string | undefined;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 4 });
    await pool.query(`CREATE TABLE IF NOT EXISTS user_id (
      internal_id text PRIMARY KEY,
      state text,
      deleted_at timestamptz,
      deletion_id uuid
    )`);
    publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-purge-pg-'));
    prevPublicDir = process.env.PUBLIC_DIR;
    prevBackendUrl = process.env.BACKEND_URL;
    process.env.PUBLIC_DIR = publicDir;
    process.env.BACKEND_URL = 'https://api.test';
  });

  afterAll(async () => {
    if (publicDir) fs.rmSync(publicDir, { recursive: true, force: true });
    if (prevPublicDir === undefined) delete process.env.PUBLIC_DIR;
    else process.env.PUBLIC_DIR = prevPublicDir;
    if (prevBackendUrl === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = prevBackendUrl;
    await pool?.query('DROP TABLE IF EXISTS user_id CASCADE').catch(() => undefined);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE user_id CASCADE');
    await pool.query(
      `INSERT INTO user_id (internal_id, state, deleted_at, deletion_id)
       VALUES ($1, 'deleted', now(), $2)`,
      [USER, DELETION_ID],
    );
    fs.rmSync(path.join(publicDir, 'avatars'), { recursive: true, force: true });
  });

  function makeService(storageLog: string[]) {
    return new AvatarService(
      { query: (sql: string, params?: any[]) => pool.query(sql, params) } as any,
      makeStorage(storageLog) as any,
    );
  }

  const account = { userId: USER, deletionId: DELETION_ID, deletedAt: new Date() };

  it('discovery: один пустой job на удалённое поколение', async () => {
    const plan = await discoverAvatarDeletion({ db: pool, account, origin: 'explicit' });

    expect(plan.jobs).toHaveLength(1);
    expect(plan.jobs[0].resourceType).toBe('avatar.purge');
    expect(plan.jobs[0].payload).toEqual({});
    expect(plan.skips).toEqual([]);
    expect(JSON.stringify(plan.jobs)).not.toContain(USER);
  });

  it('discovery: старое поколение (reactivation) — план пустой', async () => {
    const plan = await discoverAvatarDeletion({
      db: pool,
      account: { ...account, deletionId: OLD_DELETION_ID },
      origin: 'explicit',
    });

    expect(plan).toEqual({ jobs: [], skips: [] });
  });

  it('purge: канонические ключи MinIO и легаси-файл удалены', async () => {
    const calls: string[] = [];
    const svc = makeService(calls);
    fs.mkdirSync(path.join(publicDir, 'avatars'), { recursive: true });
    const legacy = path.join(publicDir, 'avatars', `${USER}.jpg`);
    fs.writeFileSync(legacy, 'jpeg-bytes');

    await svc.deleteAvatarForDeletion(USER, DELETION_ID);

    expect(calls).toEqual(
      ['jpg', 'png', 'webp', 'gif'].map((ext) =>
        `storage.delete:${ASSETS_BUCKET}/avatars/users/${USER}.${ext}`),
    );
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('reactivation — DeletionCancelledError, ничего не удалено', async () => {
    const calls: string[] = [];
    const svc = makeService(calls);
    await pool.query(
      `UPDATE user_id SET state = 'active', deletion_id = NULL WHERE internal_id = $1`,
      [USER],
    );

    await expect(svc.deleteAvatarForDeletion(USER, DELETION_ID))
      .rejects.toBeInstanceOf(DeletionCancelledError);
    expect(calls).toEqual([]);
  });

  it('повтор без объектов и файла — идемпотентный success', async () => {
    const calls: string[] = [];
    const svc = makeService(calls);

    await expect(svc.deleteAvatarForDeletion(USER, DELETION_ID)).resolves.toBeUndefined();
    expect(calls).toHaveLength(4);
  });
});
