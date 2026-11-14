import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import axios from 'axios';
import type {
  DeletionAccount,
  DeletionExecution,
  DeletionJobRow,
} from '../account-deletion/account-deletion.types';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import { VoiceAvatarService } from './voice-avatar.service';
import {
  discoverVoiceAvatarDeletion,
  VoiceAvatarAccountDeletionAdapter,
} from './voice-account-deletion.adapter';

jest.mock('axios');

/**
 * Task 14 против живого Postgres: discovery SQL user_voice (generation
 * predicate) и строгий execute адаптера (подтверждённый внешний исход до
 * DELETE row с generation predicate). Внешний провайдер — фейковый axios,
 * сетевых вызовов нет.
 */

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

const USER = 'u-deleted';
const DELETION_ID = randomUUID();
const OLD_DELETION_ID = randomUUID();
const VOICE_ID = 'voice-external-1';

const del = axios.delete as jest.Mock;

maybe('elevenlabs-voice.purge против живого Postgres (Task 14)', () => {
  jest.setTimeout(30_000);

  let pool: Pool;
  let prevKey: string | undefined;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 4 });
    await pool.query(`CREATE TABLE IF NOT EXISTS user_voice (
      user_id              text PRIMARY KEY,
      elevenlabs_voice_id  text,
      voice_descriptor     jsonb,
      sample_url           text,
      consent_at           timestamptz,
      status               text NOT NULL DEFAULT 'pending',
      error_message        text,
      created_at           timestamptz DEFAULT now(),
      updated_at           timestamptz DEFAULT now()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS user_id (
      internal_id text PRIMARY KEY,
      state text,
      deleted_at timestamptz,
      deletion_id uuid
    )`);
    prevKey = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = 'el-key-placeholder-for-spec';
  });

  afterAll(async () => {
    if (prevKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = prevKey;
    await pool?.query('TRUNCATE user_voice, user_id CASCADE').catch(() => undefined);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE user_voice, user_id CASCADE');
    await pool.query(
      `INSERT INTO user_id (internal_id, state, deleted_at, deletion_id)
       VALUES ($1, 'deleted', now(), $2)`,
      [USER, DELETION_ID],
    );
    del.mockReset();
    del.mockResolvedValue({ status: 200, data: {} });
  });

  const account: DeletionAccount = {
    userId: USER,
    deletionId: DELETION_ID,
    deletedAt: new Date(),
  };

  function makeCtx(): DeletionExecution & { assertCurrent: jest.Mock } {
    return {
      db: { query: (sql: string, params?: any[]) => pool.query(sql, params) },
      assertCurrent: jest.fn(async () => undefined),
    };
  }

  function makeAdapter() {
    const svc = new VoiceAvatarService(null as any);
    const registry = new AccountDeletionRegistry();
    return new VoiceAvatarAccountDeletionAdapter(svc, registry);
  }

  async function seedVoice(voiceId: string | null) {
    await pool.query(
      `INSERT INTO user_voice (user_id, elevenlabs_voice_id, status, consent_at)
       VALUES ($1, $2, 'ready', now())`,
      [USER, voiceId],
    );
  }

  function job(payload: Record<string, unknown> = { voiceId: VOICE_ID }): DeletionJobRow {
    return {
      id: 'job-voice-pg-1',
      deletionId: DELETION_ID,
      userId: USER,
      resourceType: 'elevenlabs-voice.purge',
      resourceKey: 'voice-pg-key',
      phase: 'purge',
      payload,
      status: 'running',
      attempts: 1,
      nextAttemptAt: new Date(),
      leaseUntil: new Date(),
      lastErrorKind: null,
    };
  }

  it('discovery: job только на удалённое поколение с внешним id', async () => {
    await seedVoice(VOICE_ID);

    const plan = await discoverVoiceAvatarDeletion({
      db: { query: (sql: string, params?: any[]) => pool.query(sql, params) },
      account,
      origin: 'explicit',
    });

    expect(plan.jobs).toHaveLength(1);
    expect(plan.jobs[0].payload).toEqual({ voiceId: VOICE_ID });
    expect(plan.skips).toEqual([]);
  });

  it('discovery: NULL id, active и чужое поколение — план пустой', async () => {
    await seedVoice(null);
    let plan = await discoverVoiceAvatarDeletion({
      db: { query: (sql: string, params?: any[]) => pool.query(sql, params) },
      account,
      origin: 'explicit',
    });
    expect(plan).toEqual({ jobs: [], skips: [] });

    await pool.query('TRUNCATE user_voice');
    await seedVoice(VOICE_ID);
    await pool.query(`UPDATE user_id SET state = 'active', deletion_id = NULL WHERE internal_id = $1`, [USER]);
    plan = await discoverVoiceAvatarDeletion({
      db: { query: (sql: string, params?: any[]) => pool.query(sql, params) },
      account,
      origin: 'explicit',
    });
    expect(plan).toEqual({ jobs: [], skips: [] });

    await pool.query(
      `UPDATE user_id SET state = 'deleted', deletion_id = $1 WHERE internal_id = $2`,
      [OLD_DELETION_ID, USER],
    );
    plan = await discoverVoiceAvatarDeletion({
      db: { query: (sql: string, params?: any[]) => pool.query(sql, params) },
      account,
      origin: 'explicit',
    });
    expect(plan).toEqual({ jobs: [], skips: [] });
  });

  it('execute: подтверждённое удаление — row исчезает, внешний вызов один', async () => {
    await seedVoice(VOICE_ID);
    const ctx = makeCtx();

    await makeAdapter().execute(job(), ctx);

    const rows = await pool.query('SELECT * FROM user_voice');
    expect(rows.rowCount).toBe(0);
    expect(del).toHaveBeenCalledTimes(1);
    expect(ctx.assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('execute: unknown outcome — retry, row и внешний id переживают попытку', async () => {
    await seedVoice(VOICE_ID);
    del.mockReset();
    del.mockRejectedValue({ code: 'ETIMEDOUT' });

    await expect(makeAdapter().execute(job(), makeCtx())).rejects.toMatchObject({ kind: 'timeout' });

    const rows = await pool.query(
      'SELECT elevenlabs_voice_id FROM user_voice WHERE user_id = $1',
      [USER],
    );
    expect(rows.rows[0]?.elevenlabs_voice_id).toBe(VOICE_ID);
  });

  it('execute: reactivation в БД — идемпотентный успех без внешнего вызова, row цела', async () => {
    await seedVoice(VOICE_ID);
    await pool.query(`UPDATE user_id SET state = 'active', deletion_id = NULL WHERE internal_id = $1`, [USER]);

    await makeAdapter().execute(job(), makeCtx());

    expect(del).not.toHaveBeenCalled();
    const rows = await pool.query('SELECT elevenlabs_voice_id FROM user_voice WHERE user_id = $1', [USER]);
    expect(rows.rows[0]?.elevenlabs_voice_id).toBe(VOICE_ID);
  });
});
