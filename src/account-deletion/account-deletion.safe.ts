import { createHash } from 'crypto';
import type {
  DeletionErrorKind,
  DeletionJobSpec,
  DeletionSkip,
  DeletionSkipReason,
} from './account-deletion.types';

export const ACCOUNT_DELETION_RETENTION_DAYS = 30;
export const ACCOUNT_DELETION_RETENTION_MS =
  ACCOUNT_DELETION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const ACCOUNT_DELETION_WORKER_DEFAULT_ENABLED = false;

const FORBIDDEN_KEYS = new Set([
  'text',
  'content',
  'prompt',
  'message',
  'token',
  'secret',
  'secretenc',
  'password',
  'userid',
  'composedplan',
  'foundfile',
  'credentialsurl',
  'credentialurl',
  'accesstoken',
  'refreshtoken',
  'clientsecret',
]);
const FORBIDDEN_KEY_PARTS = new Set([
  'token',
  'secret',
  'password',
  'credential',
  'credentials',
  'authorization',
]);
const URL_WITH_CREDENTIALS = /[a-z][a-z0-9+.-]*:\/\/[^/\s@]*:[^/\s@]*@/i;
const DELETION_ERROR_KINDS = new Set<DeletionErrorKind>([
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
]);
const DELETION_SKIP_REASONS = new Set<DeletionSkipReason>([
  'owner_unverifiable',
  'unsupported_external',
  'external_note_id_unavailable',
]);

function unsafePayloadKey(key: string): boolean {
  const parts = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const normalized = parts.join('');
  if (FORBIDDEN_KEYS.has(normalized)) return true;
  if (parts.some((part) => FORBIDDEN_KEY_PARTS.has(part))) return true;
  return (parts.includes('api') || parts.includes('private')) && parts.includes('key');
}

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
    if (key && unsafePayloadKey(key)) throw new Error('unsafe_payload');
    if (typeof value === 'string') {
      if (userId.length >= 6 && value.includes(userId)) throw new Error('unsafe_payload');
      if (URL_WITH_CREDENTIALS.test(value)) throw new Error('unsafe_payload');
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item));
    } else if (value && typeof value === 'object') {
      Object.entries(value).forEach(([nestedKey, nestedValue]) => visit(nestedValue, nestedKey));
    }
  };

  visit(job.payload);
  if (userId.length >= 6 && job.resourceKey.includes(userId)) {
    throw new Error('unsafe_payload');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(job.resourceKey)) {
    throw new Error('unsafe_resource_key');
  }
}

export function assertSafeSkip(skip: DeletionSkip): void {
  if (!DELETION_SKIP_REASONS.has(skip.reason)) throw new Error('unsafe_skip_reason');
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
  if (typeof error?.kind === 'string' && DELETION_ERROR_KINDS.has(error.kind)) {
    return error.kind;
  }
  if (error?.code === 'ETIMEDOUT' || error?.name === 'TimeoutError') return 'timeout';
  const status = error?.response?.status ?? error?.$metadata?.httpStatusCode ?? 0;
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'permission';
  if (status >= 500) return 'external_5xx';
  if (status >= 400) return 'external_4xx';
  if (typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)) return 'db';
  return 'external_unknown';
}
