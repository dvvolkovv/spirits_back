import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { AccountDeletionPlanner } from './account-deletion.planner';
import { AccountDeletionJobs } from './account-deletion.jobs';
import {
  DELETION_DEPENDENCIES,
  DELETION_DISCOVERERS,
} from './account-deletion.catalog';
import { DeletionCancelledError } from './account-deletion.safe';
import { discoverRoutinePushDeletion } from '../routine-push/routine-account-deletion.adapter';
import { discoverTelegramDeletion } from '../tg-bot/tg-account-deletion.adapter';
import { discoverProductDeletion } from '../products/product-account-deletion.adapter';
import { discoverCalendarDeletion } from '../calendar/calendar-account-deletion.adapter';
import { discoverIntegrationDeletion } from '../integrations/integration-account-deletion.adapter';
import { discoverVoiceDeletion } from '../voice-call/voice-account-deletion.adapter';
import { discoverVoiceDocuments } from '../voice-call/voice-document-account-deletion';
import { discoverChatFiles } from '../chat/chat-files/chat-file-account-deletion.adapter';
import { discoverImageDeletion } from '../misc/image-account-deletion.adapter';
import { discoverVideoDeletion } from '../video/video-account-deletion.adapter';
import { discoverSpeechDeletion } from '../speech/speech-account-deletion.adapter';
import { discoverAvatarDeletion } from '../avatar/avatar-account-deletion.adapter';
import { discoverVoiceAvatarDeletion } from '../voice-avatar/voice-account-deletion.adapter';
import { discoverEventsDeletion } from '../events/events-account-deletion.adapter';
import { discoverTasksDeletion } from '../tasks/tasks-account-deletion.adapter';
import { discoverSupportDeletion } from '../support/support-account-deletion.adapter';
import { discoverPeerDeletion } from '../peer/peer-account-deletion.adapter';
import { discoverContactsDeletion } from '../contacts/contacts-account-deletion.adapter';
import { discoverReferralDeletion } from '../referral/referral-account-deletion.adapter';
import { discoverRetentionDeletion } from '../retention/retention-account-deletion.adapter';
import type {
  DeletionAccount,
  DeletionJobRow,
  DeletionJobSpec,
  DeletionSkip,
} from './account-deletion.types';

const PG = process.env.PROVISIONING_PG_URL;
const DELETED_AT = new Date('2026-11-01T00:00:00.000Z');
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CANARY = 'CANARY_ACCOUNT_DELETION';

(PG ? describe : describe.skip)('account deletion planner', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG });
    await pool.query(`
      CREATE TABLE user_id (
        internal_id text PRIMARY KEY,
        state text,
        update_date timestamptz DEFAULT now()
      )
    `);
    await pool.query(readFileSync(
      'src/account-deletion/migrations/001_account_deletion.sql',
      'utf8',
    ));
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM account_deletion_jobs');
    await pool.query('DELETE FROM user_id');
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query('DROP TABLE IF EXISTS account_deletion_jobs, user_id')
      .catch(() => undefined);
    await pool.end();
  });

  function account(overrides: Partial<DeletionAccount> = {}): DeletionAccount {
    return {
      userId: 'u-deleted',
      deletionId: randomUUID(),
      deletedAt: DELETED_AT,
      ...overrides,
    };
  }

  async function insertDeleted(
    value: DeletionAccount,
    state = 'deleted',
  ): Promise<void> {
    await pool.query(
      `INSERT INTO user_id (internal_id,state,deleted_at,deletion_id)
       VALUES ($1,$2,$3,$4)`,
      [value.userId, state, value.deletedAt, value.deletionId],
    );
  }

  async function jobCount(): Promise<number> {
    const result = await pool.query('SELECT count(*)::int AS count FROM account_deletion_jobs');
    return result.rows[0].count;
  }

  it('persist идемпотентен, collect не пишет и сохраняет последний external ID', async () => {
    const value = account();
    await insertDeleted(value);
    const discovery = jest.fn(async () => ({
      jobs: [{
        resourceType: 'elevenlabs-voice.purge' as const,
        resourceKey: 'voice-1',
        phase: 'purge' as const,
        payload: { voiceId: 'external-1' },
      }],
      skips: [],
    }));
    const planner = new AccountDeletionPlanner([discovery]);

    const first = await planner.collect(pool, value, 'merge');

    expect(first.jobs[0]).toEqual({
      resourceType: 'account.core.purge',
      resourceKey: 'account',
      phase: 'purge',
      payload: {},
    });
    expect(first.jobs[1]).toEqual({
      resourceType: 'elevenlabs-voice.purge',
      resourceKey: 'voice-1',
      phase: 'purge',
      payload: { voiceId: 'external-1' },
    });
    expect(first.skips).toEqual([]);
    expect(discovery).toHaveBeenCalledWith({ db: pool, account: value, origin: 'merge' });
    expect(await jobCount()).toBe(0);

    await planner.persist(pool, value, first);
    await pool.query(
      `UPDATE account_deletion_jobs
       SET payload_jsonb='{"voiceId":"external-retry"}'::jsonb
       WHERE resource_type='elevenlabs-voice.purge'`,
    );
    await planner.persist(pool, value, first);

    const rows = await pool.query(
      `SELECT payload_jsonb FROM account_deletion_jobs
       WHERE resource_type='elevenlabs-voice.purge'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].payload_jsonb).toEqual({ voiceId: 'external-retry' });
    expect(await jobCount()).toBe(2);
  });

  it('explicit создаёт только account.core.immediate с next_attempt_at≈now', async () => {
    const value = account();
    await insertDeleted(value);
    const planner = new AccountDeletionPlanner([]);

    const plan = await planner.collect(pool, value, 'explicit');

    expect(plan).toEqual({
      jobs: [{
        resourceType: 'account.core.immediate',
        resourceKey: 'account',
        phase: 'immediate',
        payload: {},
      }],
      skips: [],
    });
    const before = Date.now();
    await planner.persist(pool, value, plan);
    const after = Date.now();
    const result = await pool.query(
      `SELECT resource_type,phase,next_attempt_at
       FROM account_deletion_jobs`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      resource_type: 'account.core.immediate',
      phase: 'immediate',
    });
    expect(result.rows[0].next_attempt_at.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.rows[0].next_attempt_at.getTime()).toBeLessThanOrEqual(after);
  });

  it('merge создаёт только account.core.purge с deletedAt+30d', async () => {
    const value = account();
    await insertDeleted(value);
    const planner = new AccountDeletionPlanner([]);

    const plan = await planner.collect(pool, value, 'merge');

    expect(plan.jobs).toEqual([{
      resourceType: 'account.core.purge',
      resourceKey: 'account',
      phase: 'purge',
      payload: {},
    }]);
    await planner.persist(pool, value, plan);
    const result = await pool.query(
      `SELECT resource_type,phase,next_attempt_at
       FROM account_deletion_jobs`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      resource_type: 'account.core.purge',
      phase: 'purge',
    });
    expect(result.rows[0].next_attempt_at).toEqual(
      new Date(DELETED_AT.getTime() + RETENTION_MS),
    );
  });

  it('collect применяет safety к каждому discovered job', async () => {
    const value = account();
    const planner = new AccountDeletionPlanner([async () => ({
      jobs: [{
        resourceType: 'elevenlabs-voice.purge' as const,
        resourceKey: 'voice-1',
        phase: 'purge' as const,
        payload: { text: 'private content' },
      }],
      skips: [],
    })]);

    await expect(planner.collect(pool, value, 'merge')).rejects.toThrow('unsafe_payload');
    expect(await jobCount()).toBe(0);
  });

  it('collect+persist вызывает stateful toJSON один раз и сохраняет проверенный JSON', async () => {
    const value = account();
    await insertDeleted(value);
    let calls = 0;
    const payload = {
      toJSON: () => {
        calls += 1;
        return calls === 1 ? { voiceId: 'voice-1' } : { text: CANARY };
      },
    };
    const planner = new AccountDeletionPlanner([async () => ({
      jobs: [{
        resourceType: 'elevenlabs-voice.purge' as const,
        resourceKey: 'voice-1',
        phase: 'purge' as const,
        payload,
      }],
      skips: [],
    })]);

    const plan = await planner.collect(pool, value, 'merge');
    await planner.persist(pool, value, plan);

    const result = await pool.query(
      `SELECT payload_jsonb::text AS payload FROM account_deletion_jobs
       WHERE resource_type='elevenlabs-voice.purge'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].payload).not.toContain(CANARY);
    expect(JSON.parse(result.rows[0].payload)).toEqual({ voiceId: 'voice-1' });
    expect(calls).toBe(1);
  });

  it('direct persist вызывает stateful toJSON один раз и сохраняет первый результат', async () => {
    const value = account();
    await insertDeleted(value);
    let calls = 0;
    const payload = {
      toJSON: () => {
        calls += 1;
        return calls === 1 ? { voiceId: 'voice-1' } : { text: CANARY };
      },
    };
    const planner = new AccountDeletionPlanner([]);

    await planner.persist(pool, value, {
      jobs: [{
        resourceType: 'elevenlabs-voice.purge',
        resourceKey: 'voice-1',
        phase: 'purge',
        payload,
      }],
      skips: [],
    });

    const result = await pool.query(
      `SELECT payload_jsonb::text AS payload FROM account_deletion_jobs
       WHERE resource_type='elevenlabs-voice.purge'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].payload).not.toContain(CANARY);
    expect(JSON.parse(result.rows[0].payload)).toEqual({ voiceId: 'voice-1' });
    expect(calls).toBe(1);
  });

  it('persist использует metadata snapshot, снятый до stateful toJSON', async () => {
    const value = account();
    await insertDeleted(value);
    let calls = 0;
    const job: DeletionJobSpec = {
      resourceType: 'elevenlabs-voice.purge',
      resourceKey: 'voice-1',
      phase: 'purge',
      payload: {},
    };
    job.payload = {
      toJSON: () => {
        calls += 1;
        job.resourceType = 'account.core.immediate';
        job.resourceKey = 'mutated-key';
        job.phase = 'immediate';
        return { voiceId: 'voice-1' };
      },
    };
    const planner = new AccountDeletionPlanner([]);

    await planner.persist(pool, value, { jobs: [job], skips: [] });

    const result = await pool.query(
      `SELECT resource_type,resource_key,phase,payload_jsonb,next_attempt_at
       FROM account_deletion_jobs WHERE deletion_id=$1`,
      [value.deletionId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      resource_type: 'elevenlabs-voice.purge',
      resource_key: 'voice-1',
      phase: 'purge',
      payload_jsonb: { voiceId: 'voice-1' },
    });
    expect(result.rows[0].next_attempt_at).toEqual(
      new Date(DELETED_AT.getTime() + RETENTION_MS),
    );
    expect(calls).toBe(1);
  });

  it('direct persist отклоняет inconsistent phase до любой записи', async () => {
    const value = account();
    await insertDeleted(value);
    const planner = new AccountDeletionPlanner([]);

    await expect(planner.persist(pool, value, {
      jobs: [{
        resourceType: 'elevenlabs-voice.purge',
        resourceKey: 'voice-1',
        phase: 'immediate',
        payload: { voiceId: 'voice-1' },
      }],
      skips: [],
    })).rejects.toThrow('unsafe_phase');
    expect(await jobCount()).toBe(0);
  });

  it('persist отклоняет unsafe mutated payload до любой записи', async () => {
    const value = account();
    await insertDeleted(value);
    const planner = new AccountDeletionPlanner([async () => ({
      jobs: [{
        resourceType: 'elevenlabs-voice.purge' as const,
        resourceKey: 'voice-1',
        phase: 'purge' as const,
        payload: { voiceId: 'voice-1' },
      }],
      skips: [],
    })]);
    const plan = await planner.collect(pool, value, 'merge');
    plan.jobs[1].payload = { text: CANARY };

    await expect(planner.persist(pool, value, plan)).rejects.toThrow('unsafe_payload');
    expect(await jobCount()).toBe(0);
  });

  it('collect отклоняет arbitrary skip reason и не возвращает plan', async () => {
    const value = account();
    const planner = new AccountDeletionPlanner([async () => ({
      jobs: [],
      skips: [{
        resourceType: 'calendar.external' as const,
        reason: `provider ${CANARY}` as DeletionSkip['reason'],
      }],
    })]);

    await expect(planner.collect(pool, value, 'merge'))
      .rejects.toThrow(/^unsafe_skip_reason$/);
    expect(await jobCount()).toBe(0);
  });

  it('collect сохраняет skip snapshot до вызова следующего discoverer', async () => {
    const value = account();
    const skip: DeletionSkip = {
      resourceType: 'calendar.external',
      reason: 'owner_unverifiable',
    };
    const planner = new AccountDeletionPlanner([
      async () => ({ jobs: [], skips: [skip] }),
      async () => {
        skip.reason = `provider ${CANARY}` as DeletionSkip['reason'];
        return { jobs: [], skips: [] };
      },
    ]);

    const plan = await planner.collect(pool, value, 'merge');

    expect(plan.skips).toEqual([{
      resourceType: 'calendar.external',
      reason: 'owner_unverifiable',
    }]);
    expect(JSON.stringify(plan.skips)).not.toContain(CANARY);
  });

  it('catalog описывает только заданные зависимости', () => {
    expect(DELETION_DISCOVERERS).toEqual([
      discoverRoutinePushDeletion,
      discoverTelegramDeletion,
      discoverProductDeletion,
      discoverCalendarDeletion,
      discoverIntegrationDeletion,
      discoverVoiceDeletion,
      discoverVoiceDocuments,
      discoverChatFiles,
      discoverImageDeletion,
      discoverVideoDeletion,
      discoverSpeechDeletion,
      discoverAvatarDeletion,
      discoverVoiceAvatarDeletion,
      discoverEventsDeletion,
      discoverTasksDeletion,
      discoverSupportDeletion,
      discoverPeerDeletion,
      discoverContactsDeletion,
      discoverReferralDeletion,
      discoverRetentionDeletion,
    ]);
    expect(DELETION_DEPENDENCIES['account.core.immediate']).toEqual({ allStop: true });
    expect(DELETION_DEPENDENCIES['account.core.purge']).toEqual({ allStop: true });
    expect(DELETION_DEPENDENCIES['product.purge']).toEqual({
      sameResourceKey: ['product.stop'],
    });
    expect(DELETION_DEPENDENCIES['custom-agent.purge']).toEqual({
      allOf: ['telegram.purge'],
    });
    expect(DELETION_DEPENDENCIES['voice.purge']).toEqual({
      sameResourceKey: ['voice.stop'],
      allOf: ['voice-document.purge'],
    });
    expect(DELETION_DEPENDENCIES['routine.purge']).toBeUndefined();
    expect(DELETION_DEPENDENCIES['calendar.purge']).toEqual({
      allOf: ['calendar.stop'],
    });
    // Task 17A: purge tasks/support ждёт свой stop (resourceKey статический,
    // allOf эквивалентно sameResourceKey — форма calendar.purge).
    expect(DELETION_DEPENDENCIES['tasks.purge']).toEqual({
      allOf: ['tasks.stop'],
    });
    expect(DELETION_DEPENDENCIES['support.purge']).toEqual({
      allOf: ['support.stop'],
    });
    // Task 17B: peer.purge ждёт peer.stop (алиасинг после снятия своих
    // pending-заявок); у contacts.purge stop-фазы нет — правило не нужно.
    expect(DELETION_DEPENDENCIES['peer.purge']).toEqual({
      allOf: ['peer.stop'],
    });
    expect(DELETION_DEPENDENCIES['contacts.purge']).toBeUndefined();
    // Task 17C: referral.purge ждёт referral.stop (stop блокирует вывод —
    // между pending-проверкой и алиасингом новая заявка появиться не может);
    // у retention.stop purge-фазы нет — правило не нужно.
    expect(DELETION_DEPENDENCIES['referral.purge']).toEqual({
      allOf: ['referral.stop'],
    });
    expect(DELETION_DEPENDENCIES['retention.stop']).toBeUndefined();
  });

  describe('assertCurrent', () => {
    let value: DeletionAccount;
    let currentJob: DeletionJobRow;
    let jobs: AccountDeletionJobs;

    beforeEach(async () => {
      value = account();
      await insertDeleted(value);
      const leaseUntil = new Date('2099-11-12T12:34:56.789Z');
      const nextAttemptAt = new Date('2026-11-12T12:00:00.000Z');
      const inserted = await pool.query(
        `INSERT INTO account_deletion_jobs
          (deletion_id,user_id,resource_type,resource_key,phase,payload_jsonb,
           status,attempts,next_attempt_at,lease_until)
         VALUES ($1,$2,'account.core.purge','account','purge','{}'::jsonb,
                 'running',2,$3,$4)
         RETURNING id`,
        [value.deletionId, value.userId, nextAttemptAt, leaseUntil],
      );
      currentJob = {
        id: inserted.rows[0].id,
        deletionId: value.deletionId,
        userId: value.userId,
        resourceType: 'account.core.purge',
        resourceKey: 'account',
        phase: 'purge',
        payload: {},
        status: 'running',
        attempts: 2,
        nextAttemptAt,
        leaseUntil,
        lastErrorKind: null,
      };
      jobs = new AccountDeletionJobs(pool);
    });

    it('принимает running job текущей deleted generation с точным lease', async () => {
      await expect(jobs.assertCurrent(currentJob)).resolves.toBeUndefined();
    });

    it('принимает DB lease с микросекундами после round-trip в JS Date', async () => {
      await pool.query(
        `UPDATE account_deletion_jobs
         SET lease_until=date_trunc('milliseconds',now())
           + interval '5 minutes' + interval '123 microseconds'
         WHERE id=$1`,
        [currentJob.id],
      );
      const leased = await pool.query(
        'SELECT lease_until FROM account_deletion_jobs WHERE id=$1',
        [currentJob.id],
      );
      currentJob.leaseUntil = leased.rows[0].lease_until;

      await expect(jobs.assertCurrent(currentJob)).resolves.toBeUndefined();
      await expect(jobs.assertCurrent({
        ...currentJob,
        leaseUntil: new Date(currentJob.leaseUntil!.getTime() + 1),
      })).resolves.toBeUndefined();
    });

    it('отклоняет running job с NULL lease', async () => {
      await pool.query(
        'UPDATE account_deletion_jobs SET lease_until=NULL WHERE id=$1',
        [currentJob.id],
      );
      currentJob.leaseUntil = null;

      await expect(jobs.assertCurrent(currentJob))
        .rejects.toBeInstanceOf(DeletionCancelledError);
    });

    it('отклоняет running job с expired lease', async () => {
      const expired = new Date(Date.now() - 60_000);
      await pool.query(
        'UPDATE account_deletion_jobs SET lease_until=$1 WHERE id=$2',
        [expired, currentJob.id],
      );
      currentJob.leaseUntil = expired;

      await expect(jobs.assertCurrent(currentJob))
        .rejects.toBeInstanceOf(DeletionCancelledError);
    });

    it('отклоняет stale attempts', async () => {
      await expect(jobs.assertCurrent({
        ...currentJob,
        attempts: currentJob.attempts + 1,
      })).rejects.toBeInstanceOf(DeletionCancelledError);
    });

    it('принимает stale local lease при активном DB lease и текущих attempts', async () => {
      await expect(jobs.assertCurrent({
        ...currentJob,
        leaseUntil: new Date(currentJob.leaseUntil!.getTime() + 1),
      })).resolves.toBeUndefined();
    });

    it('отклоняет job, который больше не running', async () => {
      await pool.query(
        `UPDATE account_deletion_jobs SET status='pending' WHERE id=$1`,
        [currentJob.id],
      );
      await expect(jobs.assertCurrent(currentJob))
        .rejects.toBeInstanceOf(DeletionCancelledError);
    });

    it('отклоняет changed deletionId', async () => {
      await pool.query(
        'UPDATE user_id SET deletion_id=$1 WHERE internal_id=$2',
        [randomUUID(), value.userId],
      );
      await expect(jobs.assertCurrent(currentJob))
        .rejects.toBeInstanceOf(DeletionCancelledError);
    });

    it('отклоняет changed state', async () => {
      await pool.query(
        `UPDATE user_id SET state='active' WHERE internal_id=$1`,
        [value.userId],
      );
      await expect(jobs.assertCurrent(currentJob))
        .rejects.toBeInstanceOf(DeletionCancelledError);
    });
  });
});
