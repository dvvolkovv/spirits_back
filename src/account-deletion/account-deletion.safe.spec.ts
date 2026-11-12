import { createHash } from 'crypto';
import {
  ACCOUNT_DELETION_RETENTION_DAYS,
  ACCOUNT_DELETION_RETENTION_MS,
  ACCOUNT_DELETION_WORKER_DEFAULT_ENABLED,
  DELETION_RESOURCE_TYPES,
  DeletionCancelledError,
  DeletionRetryError,
  accountDeletionWorkerEnabled,
  assertSafeJobSpec,
  assertSafeSkip,
  deletionErrorKind,
  deletionPayloadJson,
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
const DELETION_ID = '11111111-1111-4111-8111-111111111111';

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
      deletionId: DELETION_ID,
      userId: USER_ID,
      resourceType: 'product.purge',
      resourceKey: 'p-1',
      attempts: 2,
      kind: 'timeout',
    });
    expect(line).toBe(`deletion=${DELETION_ID} type=product.purge key=p-1 attempt=2 kind=timeout`);
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

describe('account deletion hardening regressions', () => {
  it.each(['APISECRET', 'APIKEY', 'AUTHTOKEN', 'apikey'])(
    'блокирует полностью uppercase secret variant: %s',
    (key) => {
      expect(() => assertSafeJobSpec(job({ [key]: SECRET }), USER_ID))
        .toThrow(/^unsafe_payload$/);
    },
  );

  it.each(['note', 'notes', 'description', 'body', 'comment', 'caption'])(
    'блокирует text-like payload field: %s',
    (key) => {
      expect(() => assertSafeJobSpec(job({ [key]: CANARY }), USER_ID))
        .toThrow(/^unsafe_payload$/);
    },
  );

  it('блокирует любой URL userinfo, даже без password', () => {
    expect(() => assertSafeJobSpec(job({
      fileUrl: 'https://token@example.com/x',
    }), USER_ID)).toThrow(/^unsafe_payload$/);
  });

  it.each([
    'X-Amz-Credential',
    'X-Amz-Signature',
    'X-Amz-Security-Token',
    'X-Goog-Credential',
    'access_token',
    'accessToken',
    'token',
    'sig',
    'signature',
    'key',
    'secret',
    'password',
    'credential',
    'auth',
    'api_key',
    'authToken',
    'AUTHORIZATION',
  ])('блокирует credentials query key: %s', (queryKey) => {
    const fileUrl = `https://example.com/file?${queryKey}=technical-value`;
    expect(() => assertSafeJobSpec(job({ fileUrl }), USER_ID))
      .toThrow(/^unsafe_payload$/);
  });

  it('не блокирует public URL с обычными query params', () => {
    expect(() => assertSafeJobSpec(job({
      fileUrl: 'https://example.com/public?download=1&author=linkeon',
    }), USER_ID)).not.toThrow();
  });

  it('анализирует URL object через его JSON representation', () => {
    const file = new URL(`https://example.com/x?access_token=${encodeURIComponent(SECRET)}`);
    expect(() => assertSafeJobSpec(job({ file }), USER_ID))
      .toThrow(/^unsafe_payload$/);
  });

  it('анализирует результат custom toJSON', () => {
    expect(() => assertSafeJobSpec(job({
      document: {
        toJSON: () => ({ fileUrl: 'https://token@example.com/x' }),
      },
    }), USER_ID)).toThrow(/^unsafe_payload$/);
  });

  it('контролируемо отклоняет циклический payload', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.path = cyclic;
    expect(() => assertSafeJobSpec(job(cyclic), USER_ID))
      .toThrow(/^unsafe_payload$/);
  });

  it('контролируемо отклоняет bigint', () => {
    expect(() => assertSafeJobSpec(job({ externalId: BigInt(1) }), USER_ID))
      .toThrow(/^unsafe_payload$/);
  });

  it('экспортирует runtime Set всех 46 resource types', () => {
    expect(DELETION_RESOURCE_TYPES.size).toBe(46);
    for (const resourceType of ALL_DELETION_RESOURCE_TYPES) {
      expect(DELETION_RESOURCE_TYPES.has(resourceType)).toBe(true);
    }
  });

  it.each(['account.core.purge.typo', USER_ID])(
    'отклоняет unknown/PII resource type в job без раскрытия',
    (resourceType) => {
      expect(() => assertSafeJobSpec({
        ...job({}),
        resourceType: resourceType as any,
      }, USER_ID)).toThrow(/^unsafe_resource_type$/);
    },
  );

  it.each(['account.core.purge.typo', USER_ID])(
    'отклоняет arbitrary resource type в журнале без раскрытия',
    (resourceType) => {
      expect(() => safeDeletionMessage({
        deletionId: DELETION_ID,
      userId: USER_ID,
        resourceType: resourceType as any,
        resourceKey: 'p-1',
        attempts: 2,
        kind: 'timeout',
      })).toThrow(/^unsafe_resource_type$/);
    },
  );

  it.each([
    ['EPERM', 'permission'],
    ['EACCES', 'permission'],
    ['EBUSY', 'permission'],
    ['ENOENT', 'not_found'],
    ['ENOTFOUND', 'external_unknown'],
    ['ETIMEDOUT', 'timeout'],
  ])('классифицирует Node code до SQLSTATE regex: %s', (code, kind) => {
    expect(deletionErrorKind({ code })).toBe(kind);
  });
});

describe('account deletion parser regressions', () => {
  it('нормализует tab в полном URL с userinfo', () => {
    const fileUrl = `https://user${String.fromCharCode(9)}:${SECRET}@example.com/x`;
    expect(() => assertSafeJobSpec(job({ fileUrl }), USER_ID))
      .toThrow(/^unsafe_payload$/);
  });

  it('нормализует newline в credentials query key', () => {
    const fileUrl = `https://example.com/x?access${String.fromCharCode(10)}_token=${SECRET}`;
    expect(() => assertSafeJobSpec(job({ fileUrl }), USER_ID))
      .toThrow(/^unsafe_payload$/);
  });

  it('блокирует credentials query на IPv6 URL', () => {
    const fileUrl = `https://[::1]/x?access_token=${encodeURIComponent(SECRET)}`;
    expect(() => assertSafeJobSpec(job({ fileUrl }), USER_ID))
      .toThrow(/^unsafe_payload$/);
  });

  it('не допускает fail-open для malformed URL с credentials query', () => {
    const fileUrl = `https://[::1/x?access_token=${encodeURIComponent(SECRET)}`;
    expect(() => assertSafeJobSpec(job({ fileUrl }), USER_ID))
      .toThrow(/^unsafe_payload$/);
  });

  it('разрешает публичный IPv6 URL без credentials', () => {
    expect(() => assertSafeJobSpec(job({
      fileUrl: 'https://[::1]/public?download=1',
    }), USER_ID)).not.toThrow();
  });

  it.each([
    'adminNote',
    'noteText',
    'messageText',
    'internalComment',
    'ADMINNOTE',
    'NOTETEXT',
    'message_text',
    'INTERNALCOMMENT',
  ])('блокирует composite personal-text key: %s', (key) => {
    expect(() => assertSafeJobSpec(job({ [key]: CANARY }), USER_ID))
      .toThrow(/^unsafe_payload$/);
  });

  it('не блокирует technical IDs и contentType', () => {
    expect(() => assertSafeJobSpec(job({
      messageId: 'message-1',
      noteId: 'note-1',
      contentType: 'video/mp4',
    }), USER_ID)).not.toThrow();
  });
});

describe('account deletion embedded URL and log regressions', () => {
  it('проверяет каждый embedded URL после первого публичного', () => {
    const fileUrl = `https://example.com/?download=1 https://evil.test/x?access_token=${SECRET}`;
    expect(() => assertSafeJobSpec(job({ fileUrl }), USER_ID))
      .toThrow(/^unsafe_payload$/);
  });

  it.each(['access_token', 'client_secret', 'X-Amz-Signature', 'api_key', 'authToken'])(
    'блокирует credentials в URL hash: %s',
    (queryKey) => {
      const fileUrl = `https://example.com/x#${queryKey}=${SECRET}`;
      expect(() => assertSafeJobSpec(job({ fileUrl }), USER_ID))
        .toThrow(/^unsafe_payload$/);
    },
  );

  it('разрешает numeric technical resourceKey в job и журнале', () => {
    expect(() => assertSafeJobSpec(job({}, '123456789'), USER_ID)).not.toThrow();
    expect(() => safeDeletionMessage({
      deletionId: DELETION_ID,
      userId: USER_ID,
      resourceType: 'product.purge',
      resourceKey: '123456789',
      attempts: 2,
      kind: 'timeout',
    })).not.toThrow();
  });

  it('запрещает resourceKey, совпадающий с обязательным userId', () => {
    const input = {
      deletionId: DELETION_ID,
      userId: USER_ID,
      resourceType: 'product.purge',
      resourceKey: USER_ID,
      attempts: 2,
      kind: 'timeout',
    } as any;
    expect(() => safeDeletionMessage(input)).toThrow(/^unsafe_resource_key$/);
  });

  it('не записывает resourceKey с недопустимым форматом', () => {
    expect(() => safeDeletionMessage({
      deletionId: DELETION_ID,
      userId: USER_ID,
      resourceType: 'product.purge',
      resourceKey: 'private/key',
      attempts: 2,
      kind: 'timeout',
    })).toThrow(/^unsafe_resource_key$/);
  });

  it('не записывает arbitrary runtime kind в журнал', () => {
    expect(() => safeDeletionMessage({
      deletionId: DELETION_ID,
      userId: USER_ID,
      resourceType: 'product.purge',
      resourceKey: 'p-1',
      attempts: 2,
      kind: CANARY as any,
    })).toThrow(/^unsafe_kind$/);
  });
});

describe('account deletion contract completeness regressions', () => {
  const phasedJob = (resourceType: any, phase: 'immediate' | 'purge') => ({
    resourceType,
    resourceKey: 'abc',
    phase,
    payload: {},
  });
  const logWith = (overrides: Record<string, unknown>) => ({
    deletionId: DELETION_ID,
    userId: USER_ID,
    resourceType: 'product.purge',
    resourceKey: 'p-1',
    attempts: 2,
    kind: 'timeout',
    ...overrides,
  } as any);

  it('разрешает согласованные phase для core/stop/purge', () => {
    for (const [resourceType, phase] of [
      ['account.core.immediate', 'immediate'],
      ['routine.stop', 'immediate'],
      ['account.core.purge', 'purge'],
      ['product.purge', 'purge'],
    ] as const) {
      expect(() => assertSafeJobSpec(phasedJob(resourceType, phase), USER_ID)).not.toThrow();
    }
  });

  it.each([
    ['chat-file.purge', 'immediate'],
    ['routine.stop', 'purge'],
    ['account.core.immediate', 'purge'],
    ['account.core.purge', 'immediate'],
  ])('запрещает несогласованную phase', (resourceType, phase) => {
    expect(() => assertSafeJobSpec(
      phasedJob(resourceType, phase as 'immediate' | 'purge'),
      USER_ID,
    )).toThrow(/^unsafe_phase$/);
  });

  it.each(['calendar.external', 'video.provider'])('запрещает skip-only resource в job', (resourceType) => {
    expect(() => assertSafeJobSpec(phasedJob(resourceType, 'purge'), USER_ID))
      .toThrow(/^unsafe_resource_type$/);
  });

  it('блокирует protocol-relative URL с userinfo', () => {
    expect(() => assertSafeJobSpec(job({
      fileUrl: `//user:${SECRET}@example.com/x`,
    }), USER_ID)).toThrow(/^unsafe_payload$/);
  });

  it('декодирует и проверяет nested URL в query value', () => {
    const target = encodeURIComponent(`https://evil.test/x?access_token=${SECRET}`);
    expect(() => assertSafeJobSpec(job({
      fileUrl: `https://example.com/redirect?target=${target}`,
    }), USER_ID)).toThrow(/^unsafe_payload$/);
  });

  it('разрешает nested public URL', () => {
    const target = encodeURIComponent('https://example.com/public?download=1');
    expect(() => assertSafeJobSpec(job({
      fileUrl: `https://example.com/redirect?target=${target}`,
    }), USER_ID)).not.toThrow();
  });

  it.each(['jwt', 'code', 'session', 'session_id'])('блокирует session credentials в query: %s', (queryKey) => {
    expect(() => assertSafeJobSpec(job({
      fileUrl: `https://example.com/x?${queryKey}=${SECRET}`,
    }), USER_ID)).toThrow(/^unsafe_payload$/);
  });

  it.each(['jwt', 'code', 'session', 'session_id'])('блокирует session credentials в hash: %s', (queryKey) => {
    expect(() => assertSafeJobSpec(job({
      fileUrl: `https://example.com/x#${queryKey}=${SECRET}`,
    }), USER_ID)).toThrow(/^unsafe_payload$/);
  });

  it.each(['title', 'jwt', 'email', 'phone', 'subject', 'summary', 'cookie', 'code', 'session',
    'accessKey', 'accessKeyId', 'authKey'])(
    'блокирует personal/credential payload key: %s',
    (key) => {
      expect(() => assertSafeJobSpec(job({ [key]: CANARY }), USER_ID))
        .toThrow(/^unsafe_payload$/);
    },
  );

  it('отклоняет неизвестное поле при строгом technical allowlist', () => {
    expect(() => assertSafeJobSpec(job({ unexpected: 'technical-value' }), USER_ID))
      .toThrow(/^unsafe_payload$/);
  });

  it('разрешает technical payload fields и containers', () => {
    expect(() => assertSafeJobSpec(job({
      voiceId: 'voice-1',
      externalBotId: 'bot-1',
      productId: 'product-1',
      fileUrl: 'https://example.com/public',
      host: 'host-1',
      slug: 'slug-1',
      path: '/technical/path',
      paths: ['/technical/a'],
      bucket: 'bucket-1',
      status: 'pending',
      reason: 'external_unknown',
      attempt: 1,
      attempts: 2,
      provider: 'minio',
      kind: 'hashed',
      scope: 'account',
      dryRun: true,
      deleteOld: false,
      timeoutMs: 1000,
      maxAttempts: 5,
      retentionDays: 30,
      graceMs: 0,
      hash: 'abc123',
      url: 'https://example.com/public',
      urls: ['https://example.com/public'],
      key: 'object-key',
      keys: ['object-key'],
      id: 'technical-1',
      ids: ['technical-1'],
      messageId: 'message-1',
      noteId: 'note-1',
      contentType: 'video/mp4',
      keyKind: 'hashed',
      roomKind: 'sole',
      nested: { voiceId: 'voice-2' },
      file: { fileUrl: 'https://example.com/public' },
      document: { productId: 'product-2' },
    }), USER_ID)).not.toThrow();
  });

  it.each(['ownerId', 'internalId', 'ownerIds', 'internalIds', 'accountUserId', 'accountOwnerId'])('запрещает identity key: %s', (key) => {
    expect(() => assertSafeJobSpec(job({ [key]: 'u-owner' }), USER_ID))
      .toThrow(/^unsafe_payload$/);
  });

  it('запрещает userId в имени JSON-ключа', () => {
    expect(() => assertSafeJobSpec(job({ [`prefix${USER_ID}`]: 'technical' }), USER_ID))
      .toThrow(/^unsafe_payload$/);
  });

  it('запрещает numeric ownerId, совпадающий с userId', () => {
    expect(() => assertSafeJobSpec(job({ ownerId: Number(USER_ID) }), USER_ID))
      .toThrow(/^unsafe_payload$/);
  });

  it('запрещает numeric userId в содержимом technical ID', () => {
    expect(() => assertSafeJobSpec(job({ id: Number(USER_ID) }), USER_ID))
      .toThrow(/^unsafe_payload$/);
  });

  it('отклоняет Buffer до вызова toJSON', () => {
    const binary = Buffer.from(SECRET);
    let calls = 0;
    (binary as any).toJSON = () => {
      calls += 1;
      return { type: 'Buffer', data: [] };
    };
    expect(() => assertSafeJobSpec(job({ file: binary }), USER_ID))
      .toThrow(/^unsafe_payload$/);
    expect(calls).toBe(0);
  });

  it('отклоняет Uint8Array до сериализации', () => {
    expect(() => assertSafeJobSpec(job({ file: new Uint8Array([1, 2, 3]) }), USER_ID))
      .toThrow(/^unsafe_payload$/);
  });

  it('отклоняет ArrayBuffer до сериализации', () => {
    expect(() => assertSafeJobSpec(job({ file: new ArrayBuffer(8) }), USER_ID))
      .toThrow(/^unsafe_payload$/);
  });

  it('отклоняет Blob до сериализации', () => {
    expect(() => assertSafeJobSpec(job({ file: new Blob([SECRET]) }), USER_ID))
      .toThrow(/^unsafe_payload$/);
  });

  it.each([null, ['voice-1'], 'voice-1'])('требует plain object top-level payload', (payload) => {
    expect(() => assertSafeJobSpec({ ...job({}), payload: payload as any }, USER_ID))
      .toThrow(/^unsafe_payload$/);
  });

  it('возвращает проверенный JSON после одного stateful toJSON', () => {
    let calls = 0;
    const payload = {
      toJSON: () => {
        calls += 1;
        return calls === 1 ? { voiceId: 'voice-1' } : { text: CANARY };
      },
    };
    expect(deletionPayloadJson(payload, USER_ID)).toBe('{"voiceId":"voice-1"}');
    expect(calls).toBe(1);
  });

  it('assertSafeJobSpec использует одну сериализацию', () => {
    let calls = 0;
    const document = {
      toJSON: () => {
        calls += 1;
        return calls === 1 ? { voiceId: 'voice-1' } : { text: CANARY };
      },
    };
    expect(() => assertSafeJobSpec(job({ document }), USER_ID)).not.toThrow();
    expect(calls).toBe(1);
  });

  it.each([
    [{ kind: 'not_found', response: { status: 503 } }, 'external_5xx'],
    [{ kind: 'not_found', $metadata: { httpStatusCode: 503 } }, 'external_5xx'],
  ])('даёт HTTP status приоритет над arbitrary kind', (error, kind) => {
    expect(deletionErrorKind(error)).toBe(kind);
  });

  it.each(['account.core.purge.typo', USER_ID])('проверяет resourceType в skip', (resourceType) => {
    expect(() => assertSafeSkip({
      resourceType: resourceType as any,
      reason: 'owner_unverifiable',
    })).toThrow(/^unsafe_resource_type$/);
  });

  it.each(['d-1', `${DELETION_ID}${String.fromCharCode(10)}`, 'not-a-uuid'])(
    'требует UUID deletionId в журнале',
    (deletionId) => {
      expect(() => safeDeletionMessage(logWith({ deletionId })))
        .toThrow(/^unsafe_deletion_id$/);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, '2'])(
    'требует finite nonnegative integer attempts',
    (attempts) => {
      expect(() => safeDeletionMessage(logWith({ attempts })))
        .toThrow(/^unsafe_attempts$/);
    },
  );

  it('разрешает нулевой attempt', () => {
    expect(safeDeletionMessage(logWith({ attempts: 0 }))).toContain('attempt=0');
  });
});

describe('account deletion sanitizer regressions', () => {
  const encodeRepeated = (value: string, count: number): string => {
    let encoded = value;
    for (let index = 0; index < count; index += 1) encoded = encodeURIComponent(encoded);
    return encoded;
  };

  it('отклоняет пустое имя свойства в deletionPayloadJson', () => {
    expect(() => deletionPayloadJson({ '': CANARY }, USER_ID))
      .toThrow(/^unsafe_payload$/);
  });

  it('отклоняет пустое имя свойства в assertSafeJobSpec', () => {
    expect(() => assertSafeJobSpec(job({ '': CANARY }), USER_ID))
      .toThrow(/^unsafe_payload$/);
  });

  it.each([2, 3])('декодирует nested URL после %s-кратного encoding', (count) => {
    const target = encodeRepeated(`https://evil.test/x?jwt=${SECRET}`, count);
    expect(() => assertSafeJobSpec(job({
      fileUrl: `https://example.com/redirect?target=${target}`,
    }), USER_ID)).toThrow(/^unsafe_payload$/);
  });

  it.each([2, 3])('разрешает public nested URL после %s-кратного encoding', (count) => {
    const target = encodeRepeated('https://example.com/public?download=1', count);
    expect(() => assertSafeJobSpec(job({
      fileUrl: `https://example.com/redirect?target=${target}`,
    }), USER_ID)).not.toThrow();
  });

  it('отклоняет binary после outer toJSON до вызова binary.toJSON', () => {
    const binary = Buffer.from(SECRET);
    let binaryCalls = 0;
    (binary as any).toJSON = () => {
      binaryCalls += 1;
      return { key: SECRET };
    };
    const payload = { toJSON: () => ({ file: binary }) };
    expect(() => deletionPayloadJson(payload, USER_ID))
      .toThrow(/^unsafe_payload$/);
    expect(binaryCalls).toBe(0);
  });
});

describe('account deletion numeric property regressions', () => {
  it.each(['0', '123'])('отклоняет numeric property в deletionPayloadJson: %s', (key) => {
    const value = key === '0' ? CANARY : SECRET;
    expect(() => deletionPayloadJson({ [key]: value }, USER_ID))
      .toThrow(/^unsafe_payload$/);
  });

  it.each(['0', '123'])('отклоняет numeric property в assertSafeJobSpec: %s', (key) => {
    const value = key === '0' ? CANARY : SECRET;
    expect(() => assertSafeJobSpec(job({ [key]: value }), USER_ID))
      .toThrow(/^unsafe_payload$/);
  });

  it('сохраняет technical fields и массивы без numeric-key bypass', () => {
    const payload = {
      voiceId: 'voice-1',
      ids: ['technical-1', 'technical-2'],
      nested: [{ productId: 'product-1' }],
    };
    expect(deletionPayloadJson(payload, USER_ID)).toBe(
      '{"voiceId":"voice-1","ids":["technical-1","technical-2"],"nested":[{"productId":"product-1"}]}',
    );
    expect(() => assertSafeJobSpec(job(payload), USER_ID)).not.toThrow();
  });
});

describe('account deletion decoding boundary regressions', () => {
  it('отклоняет 6x encoded dangerous URL после bounded decode', () => {
    let fileUrl = `https://evil.test/x?jwt=${SECRET}`;
    for (let index = 0; index < 6; index += 1) fileUrl = encodeURIComponent(fileUrl);
    expect(() => assertSafeJobSpec(job({ fileUrl }), USER_ID))
      .toThrow(/^unsafe_payload$/);
  });

  it('разрешает стабильный public URL на decode boundary', () => {
    expect(() => assertSafeJobSpec(job({
      fileUrl: 'https://example.com/public?download=1',
    }), USER_ID)).not.toThrow();
  });
});

describe('account deletion key and scheme regressions', () => {
  const logInput = (overrides: Record<string, unknown> = {}) => ({
    deletionId: DELETION_ID,
    userId: USER_ID,
    resourceType: 'product.purge',
    resourceKey: 'p-1',
    attempts: 2,
    kind: 'timeout',
    ...overrides,
  } as any);
  const encodeEveryCharacter = (value: string): string => Array.from(value)
    .map((character) => `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .join('');

  it.each(['encryptionKey', 'decryptionKey', 'signingKey', 'masterKey', 'privateSigningKey'])(
    'отклоняет cryptographic secret key: %s',
    (key) => {
      expect(() => assertSafeJobSpec(job({ [key]: SECRET }), USER_ID))
        .toThrow(/^unsafe_payload$/);
    },
  );

  it('не разрешает произвольный key suffix', () => {
    expect(() => assertSafeJobSpec(job({ unexpectedKey: 'technical-value' }), USER_ID))
      .toThrow(/^unsafe_payload$/);
  });

  it.each([
    'fileKey',
    'objectKey',
    's3Key',
    'minioKey',
    'storageKey',
    'resourceKey',
    'documentKey',
    'voiceKey',
    'mediaKey',
    'cacheKey',
    'dedupeKey',
    'idempotencyKey',
    'jobKey',
    'requestKey',
    'locatorKey',
    'hashKey',
    'fileKeys',
  ])('разрешает technical key family: %s', (key) => {
    expect(() => assertSafeJobSpec(job({ [key]: 'technical-key' }), USER_ID)).not.toThrow();
  });

  it('разбирает one-slash embedded URL с credentials', () => {
    expect(() => assertSafeJobSpec(job({
      fileUrl: `redirect https:/example.com/x?access_token=${SECRET}`,
    }), USER_ID)).toThrow(/^unsafe_payload$/);
  });

  it('разбирает opaque embedded URL с credentials', () => {
    expect(() => assertSafeJobSpec(job({
      fileUrl: `redirect custom:path?access_token=${SECRET}`,
    }), USER_ID)).toThrow(/^unsafe_payload$/);
  });

  it('разрешает public one-slash URL', () => {
    expect(() => assertSafeJobSpec(job({
      fileUrl: 'redirect https:/example.com/public?download=1',
    }), USER_ID)).not.toThrow();
  });

  it('разрешает public opaque URL', () => {
    expect(() => assertSafeJobSpec(job({
      fileUrl: 'redirect custom:path?download=1',
    }), USER_ID)).not.toThrow();
  });

  it.each([
    `${encodeEveryCharacter(USER_ID)}%`,
    `${encodeURIComponent(SECRET)}%`,
    'technical%',
  ])('отклоняет malformed percent-encoding без fail-open', (fileUrl) => {
    expect(() => assertSafeJobSpec(job({ fileUrl }), USER_ID))
      .toThrow(/^unsafe_payload$/);
  });

  it('разрешает корректный percent-encoded technical value', () => {
    expect(() => assertSafeJobSpec(job({ fileUrl: 'technical%20value' }), USER_ID)).not.toThrow();
  });

  it.each([USER_ID, DELETION_ID])('требует userId для журнала с resourceKey', (resourceKey) => {
    expect(() => safeDeletionMessage(logInput({ userId: undefined, resourceKey })))
      .toThrow(/^unsafe_user_id$/);
  });

  it('отклоняет пустой userId в журнале', () => {
    expect(() => safeDeletionMessage(logInput({ userId: '' })))
      .toThrow(/^unsafe_user_id$/);
  });

  it('не журналирует UUID resourceKey самого userId', () => {
    const userId = '22222222-2222-4222-8222-222222222222';
    expect(() => safeDeletionMessage(logInput({ userId, resourceKey: userId })))
      .toThrow(/^unsafe_resource_key$/);
  });

  it('не журналирует resourceKey при точном совпадении с коротким userId', () => {
    expect(() => safeDeletionMessage(logInput({ userId: 'u123', resourceKey: 'u123' })))
      .toThrow(/^unsafe_resource_key$/);
  });
});
