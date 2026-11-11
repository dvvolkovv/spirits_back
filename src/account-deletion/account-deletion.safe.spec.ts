import { createHash } from 'crypto';
import {
  ACCOUNT_DELETION_RETENTION_DAYS,
  ACCOUNT_DELETION_RETENTION_MS,
  ACCOUNT_DELETION_WORKER_DEFAULT_ENABLED,
  DeletionCancelledError,
  DeletionRetryError,
  accountDeletionWorkerEnabled,
  assertSafeJobSpec,
  deletionErrorKind,
  deletionResourceHash,
  retryDelayMs,
  safeDeletionMessage,
} from './account-deletion.safe';
import type {
  AccountDeletionAdapter,
  DeletionJobSpec,
  DeletionResourceType,
  DeletionSkip,
} from './account-deletion.types';

const ALL_DELETION_RESOURCE_TYPES = [
  'account.core.immediate',
  'account.core.purge',
  'routine.stop',
  'routine.purge',
  'push.purge',
  'telegram.stop',
  'telegram.purge',
  'custom-agent.purge',
  'product.stop',
  'product.purge',
  'calendar.stop',
  'calendar.purge',
  'calendar.external',
  'integration.apple.stop',
  'integration.zoom.stop',
  'integration.talerid.stop',
  'voice.stop',
  'voice.purge',
  'voice-document.purge',
  'chat-file.purge',
  'image.purge',
  'video-job.purge',
  'video.provider',
  'speech.purge',
  'listen.purge',
  'avatar.purge',
  'elevenlabs-voice.purge',
  'events.purge',
  'tasks.stop',
  'tasks.purge',
  'support.stop',
  'support.purge',
  'peer.stop',
  'peer.purge',
  'contacts.purge',
  'referral.stop',
  'referral.purge',
  'retention.stop',
  'profile-backup.purge',
  'devices.purge',
  'guest-carry.stop',
  'guest.purge',
  'auth-verification.stop',
  'legacy-auth.purge',
  'legacy-smm.stop',
  'legacy-smm.purge',
] as const satisfies readonly DeletionResourceType[];

type KnownDeletionResourceType = typeof ALL_DELETION_RESOURCE_TYPES[number];
type AssertNever<T extends never> = T;
type MissingDeletionResourceType = AssertNever<
  Exclude<DeletionResourceType, KnownDeletionResourceType>
>;
type ExtraDeletionResourceType = AssertNever<
  Exclude<KnownDeletionResourceType, DeletionResourceType>
>;

// @ts-expect-error Опечатка не входит в исчерпывающий deletion contract.
const invalidDeletionResourceType: DeletionResourceType = 'account.core.purge.typo';
void invalidDeletionResourceType;

const CANARY = 'ЛИЧНЫЙ-ТЕКСТ';
const USER_ID = '79000000001';

function job(payload: Record<string, unknown>, resourceKey = 'abc') {
  return {
    resourceType: 'chat-file.purge' as const,
    resourceKey,
    phase: 'purge' as const,
    payload,
  };
}

describe('account deletion safety', () => {
  it('фиксирует полный resource type contract во всех публичных полях', () => {
    const validJob: DeletionJobSpec = job({});
    const validSkip: DeletionSkip = {
      resourceType: 'calendar.external',
      reason: 'owner_unverifiable',
    };
    const adapter: AccountDeletionAdapter = {
      resourceTypes: ALL_DELETION_RESOURCE_TYPES,
      execute: async () => undefined,
    };

    expect(ALL_DELETION_RESOURCE_TYPES).toHaveLength(46);
    expect(new Set(ALL_DELETION_RESOURCE_TYPES).size).toBe(46);
    expect(validJob.resourceType).toBe('chat-file.purge');
    expect(validSkip.resourceType).toBe('calendar.external');
    expect(adapter.resourceTypes).toBe(ALL_DELETION_RESOURCE_TYPES);
  });

  it('отклоняет личный текст без раскрытия canary', () => {
    expect(() => assertSafeJobSpec(job({ text: CANARY }), USER_ID)).toThrow(/^unsafe_payload$/);
  });

  it('отклоняет userId внутри технического ключа payload', () => {
    expect(() => assertSafeJobSpec(
      { ...job({ key: `${USER_ID}/source.mp4` }), resourceType: 'video-job.purge' },
      USER_ID,
    )).toThrow(/^unsafe_payload$/);
  });

  it('проверяет запрещённые ключи рекурсивно в объектах и массивах', () => {
    const forbidden = [
      'text', 'content', 'prompt', 'message', 'token', 'secret', 'secret_enc',
      'password', 'userId', 'user_id', 'composed_plan',
    ];
    for (const key of forbidden) {
      expect(() => assertSafeJobSpec(
        job({ nested: [{ [key]: CANARY }] }),
        USER_ID,
      )).toThrow(/^unsafe_payload$/);
    }
    expect(() => assertSafeJobSpec(
      job({ nested: [{ key: `prefix/${USER_ID}/source.mp4` }] }),
      USER_ID,
    )).toThrow(/^unsafe_payload$/);
  });

  it('принимает только ограниченный формат resourceKey', () => {
    for (const resourceKey of ['a', 'A._:-z', 'a'.repeat(128)]) {
      expect(() => assertSafeJobSpec(job({}, resourceKey), USER_ID)).not.toThrow();
    }
    for (const resourceKey of [
      '', '.abc', '-abc', ':abc', '_abc', 'a/b', 'a b', 'a'.repeat(129), 'личный',
    ]) {
      expect(() => assertSafeJobSpec(job({}, resourceKey), USER_ID)).toThrow(/^unsafe_resource_key$/);
    }
  });

  it('формирует журнал только из технических полей', () => {
    const line = safeDeletionMessage({
      deletionId: 'd-1',
      resourceType: 'product.purge',
      resourceKey: 'p-1',
      attempts: 2,
      kind: 'timeout',
    });
    expect(line).toBe('deletion=d-1 type=product.purge key=p-1 attempt=2 kind=timeout');
    expect(line).not.toContain(USER_ID);
    expect(line).not.toContain(CANARY);
  });

  it('ограничивает экспоненту шестью часами', () => {
    expect([1, 2, 3, 20].map(retryDelayMs)).toEqual([60_000, 120_000, 240_000, 21_600_000]);
  });

  it('держит worker выключенным по умолчанию и признаёт явный флаг', () => {
    expect(ACCOUNT_DELETION_WORKER_DEFAULT_ENABLED).toBe(false);
    expect(accountDeletionWorkerEnabled({})).toBe(false);
    expect(accountDeletionWorkerEnabled({ ACCOUNT_DELETION_WORKER_ENABLED: 'true' })).toBe(true);
    expect(accountDeletionWorkerEnabled({ ACCOUNT_DELETION_WORKER_ENABLED: 'false' })).toBe(false);
  });

  it('хэширует MinIO locator с NUL-разделителем', () => {
    const bucket = 'account-assets';
    const key = 'chat/file-1.mp4';
    const expected = createHash('sha256')
      .update(`${bucket}${String.fromCharCode(0)}${key}`)
      .digest('hex');
    expect(deletionResourceHash(bucket, key)).toBe(expected);
    expect(deletionResourceHash(bucket, key)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('задаёт retention ровно 30 суток', () => {
    expect(ACCOUNT_DELETION_RETENTION_DAYS).toBe(30);
    expect(ACCOUNT_DELETION_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it.each([
    [{ kind: 'cancelled' }, 'cancelled'],
    [{ code: 'ETIMEDOUT' }, 'timeout'],
    [{ name: 'TimeoutError' }, 'timeout'],
    [{ response: { status: 404 } }, 'not_found'],
    [{ $metadata: { httpStatusCode: 404 } }, 'not_found'],
    [{ response: { status: 429 } }, 'rate_limited'],
    [{ response: { status: 401 } }, 'permission'],
    [{ response: { status: 403 } }, 'permission'],
    [{ response: { status: 500 } }, 'external_5xx'],
    [{ response: { status: 503 } }, 'external_5xx'],
    [{ response: { status: 400 } }, 'external_4xx'],
    [{ response: { status: 418 } }, 'external_4xx'],
    [{ code: '23505' }, 'db'],
    [{ code: 'XX000' }, 'db'],
    [{ message: CANARY }, 'external_unknown'],
  ])('классифицирует ошибку без сырого provider message', (error, kind) => {
    expect(deletionErrorKind(error)).toBe(kind);
  });

  it('оставляет в retry/cancelled ошибках только безопасный kind', () => {
    const retry = new DeletionRetryError(deletionErrorKind({
      response: { status: 503 },
      message: CANARY,
    }));
    const cancelled = new DeletionCancelledError();
    expect(retry).toMatchObject({ kind: 'external_5xx', message: 'external_5xx' });
    expect(cancelled).toMatchObject({ kind: 'cancelled', message: 'cancelled' });
    expect(Object.keys(retry)).toEqual(['kind']);
    expect(Object.keys(cancelled)).toEqual(['kind']);
    expect(retry.message).not.toContain(CANARY);
    expect(cancelled.message).not.toContain(CANARY);
  });
});
