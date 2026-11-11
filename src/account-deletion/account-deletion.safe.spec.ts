import { createHash } from 'crypto';
import {
  ACCOUNT_DELETION_RETENTION_DAYS,
  ACCOUNT_DELETION_RETENTION_MS,
  ACCOUNT_DELETION_WORKER_DEFAULT_ENABLED,
  DeletionCancelledError,
  DeletionRetryError,
  accountDeletionWorkerEnabled,
  assertSafeJobSpec,
  assertSafeSkip,
  deletionErrorKind,
  deletionResourceHash,
  retryDelayMs,
  safeDeletionMessage,
} from './account-deletion.safe';
import type {
  AccountDeletionAdapter,
  DeletionErrorKind,
  DeletionJobSpec,
  DeletionResourceType,
  DeletionSkip,
  DeletionSkipReason,
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

const ALL_DELETION_ERROR_KINDS = [
  'timeout',
  'external_5xx',
  'external_4xx',
  'not_found',
  'permission',
  'rate_limited',
  'db',
  'external_unknown',
  'owner_unverifiable',
  'unsupported_external',
  'cancelled',
] as const satisfies readonly DeletionErrorKind[];
type KnownDeletionErrorKind = typeof ALL_DELETION_ERROR_KINDS[number];
type MissingDeletionErrorKind = AssertNever<
  Exclude<DeletionErrorKind, KnownDeletionErrorKind>
>;
type ExtraDeletionErrorKind = AssertNever<
  Exclude<KnownDeletionErrorKind, DeletionErrorKind>
>;

const ALL_DELETION_SKIP_REASONS = [
  'owner_unverifiable',
  'unsupported_external',
  'external_note_id_unavailable',
] as const satisfies readonly DeletionSkipReason[];
type KnownDeletionSkipReason = typeof ALL_DELETION_SKIP_REASONS[number];
type MissingDeletionSkipReason = AssertNever<
  Exclude<DeletionSkipReason, KnownDeletionSkipReason>
>;
type ExtraDeletionSkipReason = AssertNever<
  Exclude<KnownDeletionSkipReason, DeletionSkipReason>
>;

// @ts-expect-error Сырой provider message не входит в безопасный skip contract.
const invalidDeletionSkipReason: DeletionSkipReason = 'raw provider message';
void invalidDeletionSkipReason;

const CANARY = 'ЛИЧНЫЙ-ТЕКСТ';
const SECRET = 'СЕКРЕТ-НЕ-ЛОГИРОВАТЬ';
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

describe('account deletion quality regressions', () => {
  it.each(ALL_DELETION_ERROR_KINDS)('сохраняет безопасный kind после round-trip: %s', (kind) => {
    const error = kind === 'cancelled'
      ? new DeletionCancelledError()
      : new DeletionRetryError(kind);
    expect(deletionErrorKind(error)).toBe(kind);
    expect(deletionErrorKind({ kind })).toBe(kind);
  });

  it('отклоняет userId в resourceKey как unsafe_payload без canary', () => {
    const check = () => assertSafeJobSpec(job({}, USER_ID), USER_ID);
    expect(check).toThrow(/^unsafe_payload$/);
    expect(check).not.toThrow(USER_ID);
  });

  it.each([
    'credentialsUrl',
    'credentials_url',
    'accessToken',
    'ACCESS_TOKEN',
    'refreshToken',
    'refresh_token',
    'clientSecret',
    'client_secret_enc',
    'apiSecret',
    'awsSecretAccessKey',
    'TeXt',
    'Password',
    'composed_PLAN',
  ])('отклоняет case-insensitive secret/credential variant: %s', (key) => {
    expect(() => assertSafeJobSpec(
      job({ nested: [{ [key]: SECRET }] }),
      USER_ID,
    )).toThrow(/^unsafe_payload$/);
  });

  it('отклоняет FoundFile даже после удаления текстового поля', () => {
    expect(() => assertSafeJobSpec(job({
      FoundFile: {
        file: { key: 'chat/file.pdf' },
        createdAt: '2026-11-01T00:00:00Z',
        messageId: 1,
      },
    }), USER_ID)).toThrow(/^unsafe_payload$/);
  });

  it('отклоняет URL с password в любом техническом payload поле', () => {
    expect(() => assertSafeJobSpec(job({
      file: { fileUrl: `https://user:${SECRET}@example.com/private` },
    }), USER_ID)).toThrow(/^unsafe_payload$/);
  });

  it('не блокирует технические IDs и публичный URL', () => {
    expect(() => assertSafeJobSpec(job({
      voiceId: 'voice-1',
      externalBotId: 'bot-1',
      productId: 'product-1',
      fileUrl: 'https://example.com/public',
    }), USER_ID)).not.toThrow();
  });

  it.each(ALL_DELETION_SKIP_REASONS)('принимает безопасный skip reason', (reason) => {
    expect(() => assertSafeSkip({ resourceType: 'calendar.external', reason })).not.toThrow();
  });

  it.each([
    CANARY,
    USER_ID,
    `request failed: ${CANARY}`,
    'https://user:password@example.com/private',
  ])('отклоняет arbitrary skip reason без раскрытия исходной строки', (reason) => {
    const skip = { resourceType: 'calendar.external', reason } as DeletionSkip;
    expect(() => assertSafeSkip(skip)).toThrow(/^unsafe_skip_reason$/);
  });

  it.each([
    [429, 'rate_limited'],
    [401, 'permission'],
    [403, 'permission'],
    [500, 'external_5xx'],
    [503, 'external_5xx'],
    [400, 'external_4xx'],
    [418, 'external_4xx'],
  ])('классифицирует AWS httpStatusCode как response.status: %s', (status, kind) => {
    expect(deletionErrorKind({ $metadata: { httpStatusCode: status } })).toBe(kind);
  });
});
