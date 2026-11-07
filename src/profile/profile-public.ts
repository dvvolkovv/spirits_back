import { PUBLIC_PROFILE_KEYS } from './profile-patch';

const PROFILE_ENTITY_KEYS = ['values', 'beliefs', 'desires', 'intents', 'interests', 'skills'] as const;

type OtherUserProfileRow = {
  user_id: string;
  profile_data?: Record<string, any> | null;
};

/**
 * Сериализация чужого профиля. При paused automaticProfiling Neo4j не читается,
 * а сохранённый в PostgreSQL снимок портрета не используется как обходной путь.
 */
export function buildOtherUserProfile(
  row: OtherUserProfileRow,
  neo: Record<string, any> | null,
  includeProfile: boolean,
) {
  const pd = row.profile_data || {};
  const publicPd: Record<string, any> = {};
  for (const key of PUBLIC_PROFILE_KEYS) {
    if (pd[key] !== undefined) publicPd[key] = pd[key];
  }

  const merged: Record<string, any> = {
    name: includeProfile ? neo?.name || pd.name : pd.name,
    family_name: includeProfile ? neo?.family_name || pd.family_name : pd.family_name,
  };
  for (const key of PROFILE_ENTITY_KEYS) {
    merged[key] = includeProfile ? (neo?.[key]?.length ? neo[key] : pd[key]) || [] : [];
  }

  return {
    user_id: row.user_id,
    profile_data: { ...publicPd, ...merged },
    ...merged,
  };
}
