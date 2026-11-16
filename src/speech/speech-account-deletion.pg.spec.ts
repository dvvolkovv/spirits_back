import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { SpeechService } from './speech.service';
import { discoverSpeechDeletion } from './speech-account-deletion.adapter';

/**
 * Task 13 против живого Postgres: discovery SQL speech_clips/speech_listens
 * (keyset по uuid + generation predicate) и строгие доменные методы
 * deleteSpeechClipForDeletion (reference count общего кэша, объект до row) и
 * deleteListenForDeletion (nonce-куски по одному до row).
 */

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

const USER = 'u-deleted';
const OTHER = 'u-other';
const DELETION_ID = randomUUID();
const OLD_DELETION_ID = randomUUID();
const MINIO_BASE = 'https://minio.test';
const SPEECH_BUCKET = 'linkeon-assets';
const CACHE_KEY = 'ab'.repeat(32);
const NONCE = '0123456789abcdef';

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

maybe('speech.purge/listen.purge против живого Postgres (Task 13)', () => {
  jest.setTimeout(30_000);

  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 4 });
    await pool.query(`CREATE TABLE IF NOT EXISTS user_id (
      internal_id text PRIMARY KEY,
      state text,
      deleted_at timestamptz,
      deletion_id uuid
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS speech_clips (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL,
      assistant_id text,
      cache_key text NOT NULL,
      url text NOT NULL,
      duration_sec numeric(6,2),
      chars int NOT NULL DEFAULT 0,
      provider text NOT NULL DEFAULT 'yandex',
      voice text NOT NULL DEFAULT 'v1',
      lang text NOT NULL DEFAULT 'ru',
      tokens_spent int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz NOT NULL DEFAULT now()
    )`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS speech_clips_user_key
      ON speech_clips (user_id, cache_key)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS speech_listens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL,
      assistant text,
      cache_key text NOT NULL,
      parts jsonb NOT NULL,
      chars int NOT NULL DEFAULT 0,
      provider text NOT NULL DEFAULT 'yandex',
      voice text NOT NULL DEFAULT 'v1',
      lang text NOT NULL DEFAULT 'ru',
      tokens_spent int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz NOT NULL DEFAULT now()
    )`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS speech_listens_user_key
      ON speech_listens (user_id, cache_key)`);
  });

  afterAll(async () => {
    await pool?.query('DROP TABLE IF EXISTS speech_clips, speech_listens, user_id CASCADE')
      .catch(() => undefined);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE speech_clips, speech_listens, user_id CASCADE');
    await pool.query(
      `INSERT INTO user_id (internal_id, state, deleted_at, deletion_id)
       VALUES ($1, 'deleted', now(), $2)`,
      [USER, DELETION_ID],
    );
  });

  function makeService(storageLog: string[]) {
    const pgDuck = {
      query: (sql: string, params?: any[]) => pool.query(sql, params),
      getClient: () => pool.connect(),
    };
    return new SpeechService(pgDuck as any, makeStorage(storageLog) as any, null as any, null as any);
  }

  async function insertClip(userId: string, cacheKey: string): Promise<string> {
    const res = await pool.query(
      `INSERT INTO speech_clips (user_id, cache_key, url)
       VALUES ($1, $2, $3) RETURNING id`,
      [userId, cacheKey, `${MINIO_BASE}/${SPEECH_BUCKET}/audio/${cacheKey}.mp3`],
    );
    return String(res.rows[0].id);
  }

  async function insertListen(userId: string, cacheKey: string, parts: string[]): Promise<string> {
    const res = await pool.query(
      `INSERT INTO speech_listens (user_id, cache_key, parts)
       VALUES ($1, $2, $3::jsonb) RETURNING id`,
      [userId, cacheKey, JSON.stringify(parts)],
    );
    return String(res.rows[0].id);
  }

  const account = { userId: USER, deletionId: DELETION_ID, deletedAt: new Date() };

  it('discovery: keyset-страницы и generation predicate, payload — только технические id', async () => {
    const clipA = await insertClip(USER, CACHE_KEY);
    const clipB = await insertClip(USER, 'cd'.repeat(32));
    await insertClip(OTHER, 'ef'.repeat(32));
    const listenA = await insertListen(USER, '11'.repeat(32), []);

    const plan = await discoverSpeechDeletion({ db: pool, account, origin: 'explicit', pageSize: 1 });

    // Сначала clips (keyset по uuid), затем listens.
    const clipJobs = plan.jobs.filter((j) => j.resourceType === 'speech.purge');
    const listenJobs = plan.jobs.filter((j) => j.resourceType === 'listen.purge');
    expect(plan.jobs).toEqual([...clipJobs, ...listenJobs]);
    expect(clipJobs.map((j) => String(j.payload.clipId)).sort())
      .toEqual([clipA, clipB].sort());
    expect(clipJobs.every((j) => j.phase === 'purge' && j.resourceKey === j.payload.clipId)).toBe(true);
    expect(listenJobs).toEqual([
      { resourceType: 'listen.purge', resourceKey: listenA, phase: 'purge', payload: { listenId: listenA } },
    ]);
    expect(JSON.stringify(plan.jobs)).not.toContain(CACHE_KEY);
    expect(JSON.stringify(plan.jobs)).not.toContain('minio.test');
  });

  it('discovery: старое поколение (reactivation) — план пустой', async () => {
    await insertClip(USER, CACHE_KEY);

    const plan = await discoverSpeechDeletion({
      db: pool,
      account: { ...account, deletionId: OLD_DELETION_ID },
      origin: 'explicit',
    });

    expect(plan).toEqual({ jobs: [], skips: [] });
  });

  it('clip: единоличный владелец — объект до row, row удалена', async () => {
    const calls: string[] = [];
    const svc = makeService(calls);
    const clipId = await insertClip(USER, CACHE_KEY);

    await svc.deleteSpeechClipForDeletion(USER, clipId, DELETION_ID);

    expect(calls).toEqual([`storage.delete:${SPEECH_BUCKET}/audio/${CACHE_KEY}.mp3`]);
    const left = await pool.query('SELECT id FROM speech_clips');
    expect(left.rowCount).toBe(0);
  });

  it('clip: общий cache_key у соседа — объект сохранён, своя row удалена', async () => {
    const calls: string[] = [];
    const svc = makeService(calls);
    const clipId = await insertClip(USER, CACHE_KEY);
    await insertClip(OTHER, CACHE_KEY);

    await svc.deleteSpeechClipForDeletion(USER, clipId, DELETION_ID);

    expect(calls).toEqual([]);
    const left = await pool.query('SELECT user_id FROM speech_clips');
    expect(left.rows.map((r) => r.user_id)).toEqual([OTHER]);
  });

  it('listen: nonce-куски удаляются по одному до row', async () => {
    const calls: string[] = [];
    const svc = makeService(calls);
    const parts = [0, 1, 2].map(
      (i) => `${MINIO_BASE}/${SPEECH_BUCKET}/audio/listen/${CACHE_KEY}-${NONCE}-${i}.mp3`,
    );
    const listenId = await insertListen(USER, CACHE_KEY, parts);

    await svc.deleteListenForDeletion(USER, listenId, DELETION_ID);

    expect(calls).toEqual(parts.map((_, i) =>
      `storage.delete:${SPEECH_BUCKET}/audio/listen/${CACHE_KEY}-${NONCE}-${i}.mp3`));
    const left = await pool.query('SELECT id FROM speech_listens');
    expect(left.rowCount).toBe(0);
  });

  it('reactivation до исполнения — generation predicate: ничего не удалено, row остаётся', async () => {
    // Mid-transaction reactivation (DeletionCancelledError) покрыт unit-спеком
    // через failGenRecheck; здесь — реальный SQL generation predicate в
    // доменном чтении: поколение не совпало → ранний идемпотентный выход.
    const calls: string[] = [];
    const svc = makeService(calls);
    const clipId = await insertClip(USER, CACHE_KEY);
    await pool.query(
      `UPDATE user_id SET state = 'active', deletion_id = NULL WHERE internal_id = $1`,
      [USER],
    );

    await svc.deleteSpeechClipForDeletion(USER, clipId, DELETION_ID);

    expect(calls).toEqual([]);
    const left = await pool.query('SELECT id FROM speech_clips');
    expect(left.rowCount).toBe(1);
  });

  it('повтор при отсутствии row — идемпотентный success без удалений', async () => {
    const calls: string[] = [];
    const svc = makeService(calls);

    await svc.deleteSpeechClipForDeletion(USER, randomUUID(), DELETION_ID);
    await svc.deleteListenForDeletion(USER, randomUUID(), DELETION_ID);

    expect(calls).toEqual([]);
  });
});
