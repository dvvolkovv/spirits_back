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

export interface ProfileAccess {
  exists: boolean;
  visible: boolean;
  automaticProfiling: boolean;
}

type SearchAccessRow = {
  user_id: string;
  profile_data: unknown;
  approved_contact: boolean;
  peer: boolean;
  blocked: boolean;
};

export async function readProfileAccess(
  pg: PrivacyPg,
  requesterId: string,
  targetId: string,
): Promise<ProfileAccess> {
  const result = await pg.query(
    `WITH me AS (
       SELECT id FROM ai_profiles_consolidated WHERE user_id = $1
     ), target AS (
       SELECT id, user_id, profile_data
       FROM ai_profiles_consolidated
       WHERE user_id = $2
     )
     SELECT
       target.user_id,
       target.profile_data,
       EXISTS (
         SELECT 1 FROM contact_requests cr
         WHERE cr.status = 'approved'
           AND (
             (cr.requester_id = (SELECT id FROM me) AND cr.target_id = target.id)
             OR (cr.target_id = (SELECT id FROM me) AND cr.requester_id = target.id)
           )
       ) AS approved_contact,
       EXISTS (
         SELECT 1 FROM peer_conversations pc
         WHERE (pc.user_a_id = $1 AND pc.user_b_id = target.user_id)
            OR (pc.user_a_id = target.user_id AND pc.user_b_id = $1)
       ) AS peer,
       EXISTS (
         SELECT 1 FROM user_blocks ub
         WHERE (ub.blocker_id = $1 AND ub.blocked_id = target.user_id)
            OR (ub.blocker_id = target.user_id AND ub.blocked_id = $1)
       ) AS blocked
     FROM target`,
    [requesterId, targetId],
  );

  if (result.rows.length === 0) {
    return { exists: false, visible: false, automaticProfiling: false };
  }

  const row = result.rows[0] as SearchAccessRow;
  const settings = parsePrivacySettings(row.profile_data);
  return {
    exists: true,
    visible: requesterId === targetId || (
      !row.blocked && (settings.discoverable || row.approved_contact || row.peer)
    ),
    automaticProfiling: settings.automaticProfiling,
  };
}

export async function canViewProfile(
  pg: PrivacyPg,
  requesterId: string,
  targetId: string,
): Promise<boolean> {
  try {
    return (await readProfileAccess(pg, requesterId, targetId)).visible;
  } catch {
    return false;
  }
}

export async function canUseProfileForRequester(
  pg: PrivacyPg,
  requesterId: string,
  targetId: string,
): Promise<boolean> {
  try {
    const access = await readProfileAccess(pg, requesterId, targetId);
    return access.visible && (requesterId === targetId || access.automaticProfiling);
  } catch {
    return false;
  }
}

async function searchAccessRows(
  pg: PrivacyPg,
  requesterId: string,
  candidateIds: string[] | null,
): Promise<SearchAccessRow[]> {
  const result = await pg.query(
    `WITH me AS (
       SELECT id FROM ai_profiles_consolidated WHERE user_id = $1
     )
     SELECT
       p.user_id,
       p.profile_data,
       EXISTS (
         SELECT 1 FROM contact_requests cr
         WHERE cr.status = 'approved'
           AND (
             (cr.requester_id = (SELECT id FROM me) AND cr.target_id = p.id)
             OR (cr.target_id = (SELECT id FROM me) AND cr.requester_id = p.id)
           )
       ) AS approved_contact,
       EXISTS (
         SELECT 1 FROM peer_conversations pc
         WHERE (pc.user_a_id = $1 AND pc.user_b_id = p.user_id)
            OR (pc.user_a_id = p.user_id AND pc.user_b_id = $1)
       ) AS peer,
       EXISTS (
         SELECT 1 FROM user_blocks ub
         WHERE (ub.blocker_id = $1 AND ub.blocked_id = p.user_id)
            OR (ub.blocker_id = p.user_id AND ub.blocked_id = $1)
       ) AS blocked
     FROM ai_profiles_consolidated p
     WHERE p.user_id <> $1
       AND ($2::text[] IS NULL OR p.user_id = ANY($2::text[]))`,
    [requesterId, candidateIds],
  );
  return result.rows as SearchAccessRow[];
}

function searchableRows(rows: SearchAccessRow[]): Set<string> {
  const result = new Set<string>();
  for (const row of rows) {
    let settings: PrivacySettings;
    try {
      settings = parsePrivacySettings(row.profile_data);
    } catch {
      continue;
    }
    if (
      !row.blocked
      && settings.automaticProfiling
      && (settings.discoverable || row.approved_contact || row.peer)
    ) {
      result.add(row.user_id);
    }
  }
  return result;
}

export async function listSearchCandidateIds(
  pg: PrivacyPg,
  requesterId: string,
): Promise<Set<string>> {
  return searchableRows(await searchAccessRows(pg, requesterId, null));
}

export async function filterSearchCandidateIds(
  pg: PrivacyPg,
  requesterId: string,
  candidateIds: string[],
): Promise<Set<string>> {
  if (candidateIds.length === 0) return new Set<string>();
  return searchableRows(await searchAccessRows(pg, requesterId, candidateIds));
}
