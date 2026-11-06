import type { PgService } from '../common/services/pg.service';

export const PRIVACY_KEYS = ['automaticProfiling', 'discoverable'] as const;

export type PrivacyKey = typeof PRIVACY_KEYS[number];
export type PrivacySettings = Record<PrivacyKey, boolean>;
export type PrivacySettingsPatch = Partial<PrivacySettings>;

type PrivacyPg = Pick<PgService, 'query'>;

export class PrivacySettingsDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrivacySettingsDataError';
  }
}

export class PrivacyProfileNotFoundError extends Error {
  constructor() {
    super('Privacy profile is not available');
    this.name = 'PrivacyProfileNotFoundError';
  }
}

export function parsePrivacySettings(input: unknown): PrivacySettings {
  const stored = input == null ? {} : input;
  if (typeof stored !== 'object' || Array.isArray(stored)) {
    throw new PrivacySettingsDataError('profile_data must be an object or null');
  }

  const data = stored as Record<string, unknown>;
  const settings = {} as PrivacySettings;
  for (const key of PRIVACY_KEYS) {
    const value = data[key];
    if (value === undefined) {
      settings[key] = true;
    } else if (typeof value === 'boolean') {
      settings[key] = value;
    } else {
      throw new PrivacySettingsDataError(`${key} must be a boolean`);
    }
  }
  return settings;
}

export function assertPrivacySettingsPatch(body: unknown): asserts body is PrivacySettingsPatch {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new TypeError('Privacy settings patch must be an object');
  }

  const entries = Object.entries(body);
  if (entries.length < 1 || entries.length > PRIVACY_KEYS.length) {
    throw new TypeError('Privacy settings patch must contain one or two fields');
  }

  for (const [key, value] of entries) {
    if (!(PRIVACY_KEYS as readonly string[]).includes(key)) {
      throw new TypeError(`Unknown privacy setting: ${key}`);
    }
    if (typeof value !== 'boolean') {
      throw new TypeError(`${key} must be a boolean`);
    }
  }
}

export async function getPrivacySettings(pg: PrivacyPg, userId: string): Promise<PrivacySettings> {
  const result = await pg.query(
    'SELECT profile_data FROM ai_profiles_consolidated WHERE user_id = $1',
    [userId],
  );
  if (result.rows.length === 0) throw new PrivacyProfileNotFoundError();
  return parsePrivacySettings(result.rows[0].profile_data);
}

export async function updatePrivacySettings(
  pg: PrivacyPg,
  userId: string,
  patch: PrivacySettingsPatch,
): Promise<PrivacySettings> {
  assertPrivacySettingsPatch(patch);

  const params: any[] = [userId];
  let expression = "coalesce(nullif(profile_data, 'null'::jsonb), '{}'::jsonb)";
  for (const key of PRIVACY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    params.push(patch[key]);
    expression = `jsonb_set(${expression}, '{${key}}', to_jsonb($${params.length}::boolean), true)`;
  }

  const result = await pg.query(
    `UPDATE ai_profiles_consolidated
     SET profile_data = ${expression}, updated_at = now()
     WHERE user_id = $1
     RETURNING profile_data`,
    params,
  );
  if (result.rows.length === 0) throw new PrivacyProfileNotFoundError();
  return parsePrivacySettings(result.rows[0].profile_data);
}

export async function automaticProfilingAllowed(pg: PrivacyPg, userId: string): Promise<boolean> {
  try {
    return (await getPrivacySettings(pg, userId)).automaticProfiling;
  } catch {
    return false;
  }
}

export async function canReceiveNewProposal(pg: PrivacyPg, userId: string): Promise<boolean> {
  try {
    return (await getPrivacySettings(pg, userId)).discoverable;
  } catch {
    return false;
  }
}
