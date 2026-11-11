import { createHash } from 'crypto';
import type {
  DeletionErrorKind,
  DeletionJobSpec,
  DeletionResourceType,
  DeletionSkip,
  DeletionSkipReason,
} from './account-deletion.types';

export const ACCOUNT_DELETION_RETENTION_DAYS = 30;
export const ACCOUNT_DELETION_RETENTION_MS =
  ACCOUNT_DELETION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const ACCOUNT_DELETION_WORKER_DEFAULT_ENABLED = false;

const DELETION_RESOURCE_TYPE_LIST = [
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
export const DELETION_RESOURCE_TYPES: ReadonlySet<DeletionResourceType> =
  new Set(DELETION_RESOURCE_TYPE_LIST);

const FORBIDDEN_KEYS = new Set([
  'text',
  'content',
  'prompt',
  'message',
  'note',
  'notes',
  'description',
  'body',
  'comment',
  'caption',
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
const URL_WITH_USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^/\s?#]*@/i;
const FORBIDDEN_QUERY_PARTS = new Set([
  'token',
  'sig',
  'signature',
  'key',
  'secret',
  'password',
  'credential',
  'credentials',
  'auth',
  'authorization',
]);
const FORBIDDEN_QUERY_KEYS = new Set([
  'token',
  'sig',
  'signature',
  'key',
  'secret',
  'password',
  'credential',
  'credentials',
  'auth',
  'authorization',
  'oauth',
  'apikey',
  'accesstoken',
  'xamzcredential',
  'xamzsignature',
]);
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

function keyParts(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function unsafePayloadKey(key: string): boolean {
  const parts = keyParts(key);
  const normalized = parts.join('');
  if (FORBIDDEN_KEYS.has(normalized)) return true;
  if (parts.some((part) => FORBIDDEN_KEY_PARTS.has(part))) return true;
  if (['token', 'secret', 'password', 'credential', 'authorization']
    .some((part) => normalized.includes(part))) return true;
  if (normalized.includes('apikey') || normalized.includes('privatekey')) return true;
  return (parts.includes('api') || parts.includes('private')) && parts.includes('key');
}

function unsafeQueryKey(key: string): boolean {
  const parts = keyParts(key);
  const normalized = parts.join('');
  if (FORBIDDEN_QUERY_KEYS.has(normalized)) return true;
  if (parts.some((part) => FORBIDDEN_QUERY_PARTS.has(part))) return true;
  if (['token', 'secret', 'password', 'credential', 'signature', 'apikey', 'privatekey']
    .some((part) => normalized.includes(part))) return true;
  return /^auth(?:entication|orization|token|key|secret|code|credential|signature|sig)/
    .test(normalized);
}

function unsafePayloadString(value: string, userId: string): boolean {
  if (userId.length >= 6 && value.includes(userId)) return true;
  if (URL_WITH_USERINFO.test(value)) return true;
  const candidates = value.match(/[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi) ?? [];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.username || url.password) return true;
      for (const key of url.searchParams.keys()) {
        if (unsafeQueryKey(key)) return true;
      }
    } catch {
      // Невалидный URL уже проверен на userinfo; секреты не раскрываем.
    }
  }
  return false;
}

function assertSafeResourceType(resourceType: unknown): asserts resourceType is DeletionResourceType {
  if (typeof resourceType !== 'string'
    || !DELETION_RESOURCE_TYPES.has(resourceType as DeletionResourceType)) {
    throw new Error('unsafe_resource_type');
  }
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
  assertSafeResourceType(job.resourceType);
  try {
    JSON.stringify(job.payload, function (key, value) {
      if (key && unsafePayloadKey(key)) throw new Error('unsafe_payload');
      if (typeof value === 'bigint') throw new Error('unsafe_payload');
      if (value instanceof URL && unsafePayloadString(value.href, userId)) {
        throw new Error('unsafe_payload');
      }
      if (typeof value === 'string' && unsafePayloadString(value, userId)) {
        throw new Error('unsafe_payload');
      }
      return value;
    });
  } catch {
    throw new Error('unsafe_payload');
  }
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
  resourceType: DeletionResourceType;
  resourceKey: string;
  attempts: number;
  kind: DeletionErrorKind;
}): string {
  assertSafeResourceType(input.resourceType);
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
  if (['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) return 'permission';
  if (['ENOENT', 'ENOTFOUND'].includes(error?.code)) return 'not_found';
  if (typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)) return 'db';
  return 'external_unknown';
}
