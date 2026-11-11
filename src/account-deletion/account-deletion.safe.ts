import { createHash } from 'crypto';
import type { DeletionErrorKind, DeletionJobSpec } from './account-deletion.types';

export const ACCOUNT_DELETION_RETENTION_DAYS = 30;
export const ACCOUNT_DELETION_RETENTION_MS =
  ACCOUNT_DELETION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const ACCOUNT_DELETION_WORKER_DEFAULT_ENABLED = false;

const FORBIDDEN = new Set([
  'text',
  'content',
  'prompt',
  'message',
  'token',
  'secret',
  'secret_enc',
  'password',
  'userId',
  'user_id',
  'composed_plan',
]);

export class DeletionCancelledError extends Error {
  readonly kind = 'cancelled' as const;

  constructor() {
    super('cancelled');
  }
}

export class DeletionRetryError extends Error {
  constructor(public readonly kind: DeletionErrorKind) {
    super(kind);
  }
}

export function retryDelayMs(attempts: number): number {
  return Math.min(21_600_000, 60_000 * 2 ** Math.max(attempts - 1, 0));
}

export function deletionResourceHash(bucket: string, key: string): string {
  return createHash('sha256').update(`${bucket}\0${key}`).digest('hex');
}

export function assertSafeJobSpec(job: DeletionJobSpec, userId: string): void {
  const visit = (value: unknown, key?: string): void => {
    if (key && FORBIDDEN.has(key)) throw new Error('unsafe_payload');
    if (typeof value === 'string' && userId.length >= 6 && value.includes(userId)) {
      throw new Error('unsafe_payload');
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item));
    } else if (value && typeof value === 'object') {
      Object.entries(value).forEach(([nestedKey, nestedValue]) => visit(nestedValue, nestedKey));
    }
  };

  visit(job.payload);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(job.resourceKey)) {
    throw new Error('unsafe_resource_key');
  }
}

export function accountDeletionWorkerEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.ACCOUNT_DELETION_WORKER_ENABLED === 'false') return false;
  if (env.ACCOUNT_DELETION_WORKER_ENABLED === 'true') return true;
  return ACCOUNT_DELETION_WORKER_DEFAULT_ENABLED;
}

export function safeDeletionMessage(input: {
  deletionId: string;
  resourceType: string;
  resourceKey: string;
  attempts: number;
  kind: DeletionErrorKind;
}): string {
  return `deletion=${input.deletionId} type=${input.resourceType} key=${input.resourceKey} attempt=${input.attempts} kind=${input.kind}`;
}

export function deletionErrorKind(error: any): DeletionErrorKind {
  if (error?.kind === 'cancelled') return 'cancelled';
  if (error?.code === 'ETIMEDOUT' || error?.name === 'TimeoutError') return 'timeout';
  if (error?.$metadata?.httpStatusCode === 404 || error?.response?.status === 404) {
    return 'not_found';
  }
  if (error?.response?.status === 429) return 'rate_limited';
  if (error?.response?.status === 401 || error?.response?.status === 403) return 'permission';
  if ((error?.response?.status ?? 0) >= 500) return 'external_5xx';
  if ((error?.response?.status ?? 0) >= 400) return 'external_4xx';
  if (typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)) return 'db';
  return 'external_unknown';
}
