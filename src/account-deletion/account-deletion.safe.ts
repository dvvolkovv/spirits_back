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
const SKIP_ONLY_RESOURCE_TYPES: ReadonlySet<DeletionResourceType> =
  new Set(['calendar.external', 'video.provider']);

const FORBIDDEN_PAYLOAD_KEYS = new Set([
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
  'title',
  'subject',
  'summary',
  'email',
  'phone',
  'cookie',
  'jwt',
  'code',
  'session',
  'token',
  'secret',
  'secretenc',
  'password',
  'userid',
  'ownerid',
  'internalid',
  'composedplan',
  'foundfile',
  'credentials',
  'credential',
  'credentialsurl',
  'credentialurl',
  'accesstoken',
  'refreshtoken',
  'clientsecret',
]);
const TECHNICAL_PAYLOAD_KEYS = new Set([
  'nested',
  'file',
  'document',
  'payload',
  'items',
  'host',
  'slug',
  'bucket',
  'status',
  'reason',
  'attempt',
  'attempts',
  'provider',
  'kind',
  'scope',
  'dryrun',
  'deleteold',
  'timeoutms',
  'maxattempts',
  'retentiondays',
  'gracems',
  'hash',
  'contenttype',
  'path',
  'paths',
  'url',
  'urls',
  'key',
  'keys',
  'id',
  'ids',
]);
const TEXT_LIKE_KEY_PARTS = [
  'text',
  'note',
  'message',
  'comment',
  'caption',
  'description',
  'body',
  'title',
  'subject',
  'summary',
];
const TECHNICAL_KEY_FAMILIES = new Set([
  'filekey',
  'objectkey',
  's3key',
  'miniokey',
  'storagekey',
  'resourcekey',
  'documentkey',
  'voicekey',
  'mediakey',
  'cachekey',
  'dedupekey',
  'idempotencykey',
  'jobkey',
  'requestkey',
  'locatorkey',
  'hashkey',
]);
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
  'jwt',
  'code',
  'session',
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
  'jwt',
  'code',
  'session',
  'sessionid',
]);
const URL_WITH_USERINFO = /(?:[a-z][a-z0-9+.-]*:)?\/\/[^/\s?#]*@/i;
const RESOURCE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DELETION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  if (FORBIDDEN_PAYLOAD_KEYS.has(normalized)) return true;
  if (['userid', 'ownerid', 'internalid'].some((part) => normalized.includes(part))) {
    return true;
  }
  if (['token', 'secret', 'password', 'credential', 'authorization', 'jwt', 'cookie',
    'email', 'phone', 'session', 'code', 'accesskey', 'encryptionkey', 'decryptionkey',
    'signingkey', 'masterkey'].some((part) => normalized.includes(part))) {
    return true;
  }
  if (/^auth(?:entication|orization|token|key|secret|code|credential|signature|sig)/
    .test(normalized)) return true;
  if (!normalized.endsWith('id')
    && TEXT_LIKE_KEY_PARTS.some((part) => normalized.includes(part))) return true;
  if (normalized.includes('apikey') || normalized.includes('privatekey')) return true;
  if (TECHNICAL_PAYLOAD_KEYS.has(normalized)) return false;
  if (normalized.endsWith('id') || normalized.endsWith('ids')) return false;
  if (TECHNICAL_KEY_FAMILIES.has(normalized)) return false;
  if (normalized.endsWith('s') && TECHNICAL_KEY_FAMILIES.has(normalized.slice(0, -1))) {
    return false;
  }
  if (normalized.endsWith('url') || normalized.endsWith('urls')) return false;
  if (normalized.endsWith('path') || normalized.endsWith('paths')) return false;
  if (normalized.endsWith('kind')) return false;
  return true;
}

function unsafeQueryKey(key: string): boolean {
  const parts = keyParts(key);
  const normalized = parts.join('');
  if (FORBIDDEN_QUERY_KEYS.has(normalized)) return true;
  if (parts.some((part) => FORBIDDEN_QUERY_PARTS.has(part))) return true;
  if (['token', 'secret', 'password', 'credential', 'signature', 'apikey', 'privatekey',
    'jwt', 'session', 'code'].some((part) => normalized.includes(part))) return true;
  return /^auth(?:entication|orization|token|key|secret|code|credential|signature|sig)/
    .test(normalized);
}

function unsafeUrl(url: URL, userId: string, depth: number): boolean {
  if (url.username || url.password) return true;
  const params = [
    ...url.searchParams.entries(),
    ...new URLSearchParams(url.hash.slice(1)).entries(),
  ];
  for (const [key, value] of params) {
    if (unsafeQueryKey(key)) return true;
    if (unsafePayloadString(value, userId, depth + 1)) return true;
  }
  return false;
}

function unsafePayloadString(value: string, userId: string, depth = 0): boolean {
  if (depth > 6) return true;
  let variant = value;
  for (let pass = 0; pass <= 5; pass += 1) {
    if (variant === userId || (userId.length >= 6 && variant.includes(userId))) return true;
    if (URL_WITH_USERINFO.test(variant)) return true;
    try {
      if (unsafeUrl(new URL(variant), userId, depth)) return true;
    } catch {
      // Проверяем встроенные URL ниже.
    }
    const normalized = variant.replace(/[\t\r\n]/g, '');
    const candidates = normalized.match(/(?:[a-z][a-z0-9+.-]*:[^\s]+|\/\/[^\s]+)/gi) ?? [];
    for (const candidate of candidates) {
      try {
        const url = candidate.startsWith('//')
          ? new URL(candidate, 'https://deletion.invalid')
          : new URL(candidate);
        if (unsafeUrl(url, userId, depth)) return true;
      } catch {
        return true;
      }
    }
    if (pass === 5) {
      try {
        if (decodeURIComponent(variant) !== variant) return true;
      } catch {
        return true;
      }
      break;
    }
    try {
      const decoded = decodeURIComponent(variant);
      if (decoded === variant) break;
      variant = decoded;
    } catch {
      return true;
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

function unsafeResourceKeyFormat(resourceKey: unknown): boolean {
  return typeof resourceKey !== 'string'
    || resourceKey.trim() !== resourceKey
    || !RESOURCE_KEY_RE.test(resourceKey);
}

function isBinaryValue(value: unknown): boolean {
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return true;
  }
  return (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)
    || (typeof Blob !== 'undefined' && value instanceof Blob);
}

type PlainJsonValue = null | boolean | number | string | PlainJsonValue[] | {
  [key: string]: PlainJsonValue;
};
const OMIT_JSON_VALUE = Symbol('omit_json_value');
type SanitizedJsonValue = PlainJsonValue | typeof OMIT_JSON_VALUE;

function assertPlainPayload(payload: unknown): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('unsafe_payload');
  }
  const prototype = Object.getPrototypeOf(payload);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('unsafe_payload');
}

function sanitizeJsonValue(
  value: unknown,
  userId: string,
  stack: WeakSet<object>,
  key: string,
): SanitizedJsonValue {
  if (isBinaryValue(value) || typeof value === 'bigint') throw new Error('unsafe_payload');
  if (value === null) return null;
  if (typeof value === 'string') {
    if (unsafePayloadString(value, userId)) throw new Error('unsafe_payload');
    return value;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (String(value) === userId) throw new Error('unsafe_payload');
    return value;
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return OMIT_JSON_VALUE;
  }
  if (value instanceof URL) return sanitizeJsonValue(value.href, userId, stack, key);

  const objectValue = value as Record<string, unknown>;
  if (stack.has(objectValue)) throw new Error('unsafe_payload');
  stack.add(objectValue);
  try {
    const toJSON = objectValue.toJSON;
    if (typeof toJSON === 'function') {
      return sanitizeJsonValue(toJSON.call(objectValue, key), userId, stack, key);
    }
    if (Array.isArray(objectValue)) {
      return objectValue.map((item) => {
        const sanitized = sanitizeJsonValue(item, userId, stack, key);
        return sanitized === OMIT_JSON_VALUE ? null : sanitized;
      });
    }
    const result: Record<string, PlainJsonValue> = Object.create(null);
    for (const property of Object.keys(objectValue)) {
      if (userId.length >= 6 && property.includes(userId)) throw new Error('unsafe_payload');
      if (unsafePayloadKey(property)) throw new Error('unsafe_payload');
      const sanitized = sanitizeJsonValue(objectValue[property], userId, stack, property);
      if (sanitized !== OMIT_JSON_VALUE) result[property] = sanitized;
    }
    return result;
  } finally {
    stack.delete(objectValue);
  }
}

export function deletionPayloadJson(payload: unknown, userId: string): string {
  try {
    assertPlainPayload(payload);
    const sanitized = sanitizeJsonValue(payload, userId, new WeakSet(), '');
    if (sanitized === OMIT_JSON_VALUE || sanitized === null
      || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
      throw new Error('unsafe_payload');
    }
    const serialized = JSON.stringify(sanitized);
    if (typeof serialized !== 'string' || !serialized.startsWith('{')) {
      throw new Error('unsafe_payload');
    }
    return serialized;
  } catch {
    throw new Error('unsafe_payload');
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
  return createHash('sha256')
    .update(`${bucket}${String.fromCharCode(0)}${key}`)
    .digest('hex');
}

export function assertSafeJobSpec(job: DeletionJobSpec, userId: string): void {
  assertSafeResourceType(job.resourceType);
  if (SKIP_ONLY_RESOURCE_TYPES.has(job.resourceType)) throw new Error('unsafe_resource_type');
  const expectedPhase = job.resourceType === 'account.core.immediate'
    || job.resourceType.endsWith('.stop') ? 'immediate' : 'purge';
  if (job.phase !== expectedPhase) throw new Error('unsafe_phase');
  deletionPayloadJson(job.payload, userId);
  if (typeof job.resourceKey === 'string'
    && (job.resourceKey === userId
      || (userId.length >= 6 && job.resourceKey.includes(userId)))) {
    throw new Error('unsafe_payload');
  }
  if (unsafeResourceKeyFormat(job.resourceKey)) throw new Error('unsafe_resource_key');
}

export function assertSafeSkip(skip: DeletionSkip): void {
  assertSafeResourceType(skip.resourceType);
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
  userId: string;
}): string {
  assertSafeResourceType(input.resourceType);
  if (typeof input.userId !== 'string' || input.userId.trim().length === 0) {
    throw new Error('unsafe_user_id');
  }
  if (typeof input.deletionId !== 'string'
    || input.deletionId.length !== 36 || !DELETION_ID_RE.test(input.deletionId)) {
    throw new Error('unsafe_deletion_id');
  }
  if (unsafeResourceKeyFormat(input.resourceKey)
    || input.resourceKey === input.userId
    || (typeof input.userId === 'string' && input.userId.length >= 6
      && input.resourceKey.includes(input.userId))) {
    throw new Error('unsafe_resource_key');
  }
  if (!Number.isFinite(input.attempts) || !Number.isInteger(input.attempts) || input.attempts < 0) {
    throw new Error('unsafe_attempts');
  }
  if (!DELETION_ERROR_KINDS.has(input.kind)) throw new Error('unsafe_kind');
  return `deletion=${input.deletionId} type=${input.resourceType} key=${input.resourceKey} attempt=${input.attempts} kind=${input.kind}`;
}

export function deletionErrorKind(error: any): DeletionErrorKind {
  const status = error?.response?.status ?? error?.$metadata?.httpStatusCode ?? 0;
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'permission';
  if (status >= 500) return 'external_5xx';
  if (status >= 400) return 'external_4xx';
  if (typeof error?.kind === 'string' && DELETION_ERROR_KINDS.has(error.kind)) {
    return error.kind;
  }
  if (error?.code === 'ETIMEDOUT' || error?.name === 'TimeoutError') return 'timeout';
  if (['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) return 'permission';
  if (error?.code === 'ENOENT') return 'not_found';
  if (typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)) return 'db';
  return 'external_unknown';
}
