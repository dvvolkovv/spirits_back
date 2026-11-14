import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { MiscService } from './misc.service';
import { discoverImageDeletion } from './image-account-deletion.adapter';

/**
 * Task 12 против живого Postgres: discovery SQL generated_images (keyset +
 * generation predicate) и строгий доменный метод
 * deleteGeneratedImageForDeletion (объекты до row, поколение в transaction).
 */

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

const USER = 'u-deleted';
const DELETION_ID = randomUUID();
const OLD_DELETION_ID = randomUUID();
const MINIO_BASE = 'https://minio.test';

function makeStorage(log: Array<{ bucket: string; key: string }>) {
  return {
    deleteConfirmed: async (input: { bucket: string; key: string }) => {
      log.push(input);
      return 'deleted' as const;
    },
    delete: async () => undefined,
    publicUrl: (bucket: string, key: string) => `${MINIO_BASE}/${bucket}/${key}`,
  };
}

maybe('image.purge против живого Postgres (Task 12)', () => {
  jest.setTimeout(30_000);

  let pool: Pool;
  let publicDir: string;
  let prevPublicDir: string | undefined;
  let prevBackendUrl: string | undefined;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 4 });
    // Схема как на проде (001_core_schema.sql): integer id + sequence.
    await pool.query(`CREATE TABLE IF NOT EXISTS generated_images (
      id serial PRIMARY KEY,
      user_id text NOT NULL,
      prompt text NOT NULL,
      image_url text NOT NULL,
      tokens_spent integer DEFAULT 5000,
      created_at timestamptz DEFAULT now()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS user_id (
      internal_id text PRIMARY KEY,
      state text,
      deleted_at timestamptz,
      deletion_id uuid
    )`);
    publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-purge-pg-'));
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
    await pool?.query('TRUNCATE generated_images, user_id CASCADE').catch(() => undefined);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE generated_images, user_id RESTART IDENTITY CASCADE');
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
    return new MiscService(null as any, pgDuck as any, makeStorage(storageLog) as any, null as any);
  }

  async function insertImage(userId: string, url: string, prompt = 'ЛИЧНЫЙ-ТЕКСТ'): Promise<number> {
    const res = await pool.query(
      `INSERT INTO generated_images (user_id, prompt, image_url, tokens_spent)
       VALUES ($1,$2,$3,0) RETURNING id`,
      [userId, prompt, url],
    );
    return Number(res.rows[0].id);
  }

  it('discovery: keyset-страницы и generation predicate, payload — только imageId', async () => {
    const idA = await insertImage(USER, `${MINIO_BASE}/linkeon-assets/images/a.png`);
    const idB = await insertImage(USER, `${MINIO_BASE}/linkeon-assets/images/b.png`);
    await insertImage('u-other', `${MINIO_BASE}/linkeon-assets/images/c.png`);

    const plan = await discoverImageDeletion({
      db: pool,
      account: { userId: USER, deletionId: DELETION_ID, deletedAt: new Date() },
      origin: 'explicit',
      pageSize: 1,
    });

    expect(plan.jobs.map((j) => j.payload)).toEqual([{ imageId: idA }, { imageId: idB }]);
    expect(plan.jobs.every((j) => j.resourceType === 'image.purge')).toBe(true);
    expect(JSON.stringify(plan.jobs)).not.toContain('ЛИЧНЫЙ-ТЕКСТ');
  });

  it('discovery: старое поколение (reactivation) — план пустой', async () => {
    await insertImage(USER, `${MINIO_BASE}/linkeon-assets/images/a.png`);
    const plan = await discoverImageDeletion({
      db: pool,
      account: { userId: USER, deletionId: OLD_DELETION_ID, deletedAt: new Date() },
      origin: 'explicit',
    });
    expect(plan).toEqual({ jobs: [], skips: [] });
  });

  it('MinIO-объект удаляется до row', async () => {
    const id = await insertImage(USER, `${MINIO_BASE}/linkeon-assets/images/1700-abc.png`);
    const storageLog: Array<{ bucket: string; key: string }> = [];
    const svc = makeService(storageLog);

    await svc.deleteGeneratedImageForDeletion(USER, id, DELETION_ID);

    expect(storageLog).toEqual([{ bucket: 'linkeon-assets', key: 'images/1700-abc.png' }]);
    const rows = await pool.query('SELECT id FROM generated_images WHERE id=$1', [id]);
    expect(rows.rows).toHaveLength(0);
  });

  it('локальный /static файл удаляется с диска до row', async () => {
    fs.mkdirSync(path.join(publicDir, 'generated'), { recursive: true });
    const file = path.join(publicDir, 'generated', 'pic.png');
    fs.writeFileSync(file, 'png');
    const id = await insertImage(USER, 'https://api.test/static/generated/pic.png');
    const svc = makeService([]);

    await svc.deleteGeneratedImageForDeletion(USER, id, DELETION_ID);

    expect(fs.existsSync(file)).toBe(false);
    const rows = await pool.query('SELECT id FROM generated_images WHERE id=$1', [id]);
    expect(rows.rows).toHaveLength(0);
  });

  it('старое deletionId (reactivation) — row не тронута, объекты не удалены', async () => {
    const id = await insertImage(USER, `${MINIO_BASE}/linkeon-assets/images/a.png`);
    const storageLog: Array<{ bucket: string; key: string }> = [];
    const svc = makeService(storageLog);

    await svc.deleteGeneratedImageForDeletion(USER, id, OLD_DELETION_ID);

    expect(storageLog).toEqual([]);
    const rows = await pool.query('SELECT id FROM generated_images WHERE id=$1', [id]);
    expect(rows.rows).toHaveLength(1);
  });

  it('повторный вызов после purge — success (идемпотентность)', async () => {
    const id = await insertImage(USER, `${MINIO_BASE}/linkeon-assets/images/a.png`);
    const svc = makeService([]);

    await svc.deleteGeneratedImageForDeletion(USER, id, DELETION_ID);
    await expect(svc.deleteGeneratedImageForDeletion(USER, id, DELETION_ID)).resolves.toBeUndefined();
  });
});
