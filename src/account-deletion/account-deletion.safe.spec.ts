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

const CANARY = 'ЛИЧНЫЙ-ТЕКСТ';
const USER_ID = '79000000001';

function job(payload: Record<string, unknown>, resourceKey = 'abc') {
  return {
    resourceType: 'chat-file.purge',
    resourceKey,
    phase: 'purge' as const,
    payload,
  };
}

describe('account deletion safety', () => {
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
  ])('классифицирует ошибку без сырого provider message: %p', (error, kind) => {
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
