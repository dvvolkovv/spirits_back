import { PgService } from '../../common/services/pg.service';
import { StorageService } from '../../common/services/storage.service';
import { excludedUsers, TEST_USER_PATTERN } from '../../common/test-users';
import { chatFilesBucket } from '../../chat/chat-files/chat-file-store';

/**
 * «Медиа и файлы» в блоке «Контент» админки: панель, поиск файлов,
 * хранилище. Только агрегаты, без ленты по людям.
 */
export interface ChatFilesStats {
  panel: { opens: number; users: number };
  downloads: { total: number; byKind: Record<'image' | 'document' | 'video' | 'audio', number> };
  findFiles: { calls: number; withResults: number; withStored: number };
  storage: {
    stored: number;
    failed: number;
    topFailReason: string | null;
    /** null — MinIO не ответил. */
    bucketObjects: number | null;
    bucketBytes: number | null;
  };
}

export const CHAT_FILES_EVENTS = [
  'chat_files_panel_open', 'chat_files_download', 'find_files_call', 'chat_file_stored', 'chat_file_copy_failed',
];

const BUCKET_TTL_MS = 5 * 60_000;
let bucketCache: { at: number; value: { objects: number; bytes: number } | null } | null = null;

/** Только для тестов. */
export function __resetBucketCacheForTests(): void {
  bucketCache = null;
}

async function cachedBucketStats(storage?: Pick<StorageService, 'bucketStats'>) {
  if (!storage) return null;
  if (bucketCache && Date.now() - bucketCache.at < BUCKET_TTL_MS) return bucketCache.value;
  let value: { objects: number; bytes: number } | null = null;
  try {
    value = await storage.bucketStats(chatFilesBucket());
  } catch {
    value = null;
  }
  bucketCache = { at: Date.now(), value };
  return value;
}

/**
 * Ручка events/track анонимная, поэтому в props может прийти что угодно:
 * «больше нуля» проверяется регуляркой, а не приведением к int, которое
 * уронило бы весь запрос на мусоре.
 */
const POSITIVE = `'^[1-9][0-9]*$'`;

export async function loadChatFilesStats(
  pg: Pick<PgService, 'query'>,
  storage: Pick<StorageService, 'bucketStats'> | undefined,
  window: string,
  interval: string,
): Promise<ChatFilesStats | null> {
  const params = [window, interval, excludedUsers(), TEST_USER_PATTERN, CHAT_FILES_EVENTS];
  const where = `name = ANY($5::text[])
       AND ($1 = 'all' OR ts >= now() - $2::interval)
       AND COALESCE(user_id, '') <> ALL($3::text[])
       AND COALESCE(user_id, '') !~ $4`;
  let c: any;
  let topFailReason: string | null = null;
  try {
    c = (await pg.query(
      `SELECT
         COUNT(*) FILTER (WHERE name = 'chat_files_panel_open')::int                          AS opens,
         COUNT(DISTINCT user_id) FILTER (WHERE name = 'chat_files_panel_open')::int           AS users,
         COUNT(*) FILTER (WHERE name = 'chat_files_download')::int                            AS downloads,
         COUNT(*) FILTER (WHERE name = 'chat_files_download' AND props->>'kind' = 'image')::int    AS dl_image,
         COUNT(*) FILTER (WHERE name = 'chat_files_download' AND props->>'kind' = 'document')::int AS dl_document,
         COUNT(*) FILTER (WHERE name = 'chat_files_download' AND props->>'kind' = 'video')::int    AS dl_video,
         COUNT(*) FILTER (WHERE name = 'chat_files_download' AND props->>'kind' = 'audio')::int    AS dl_audio,
         COUNT(*) FILTER (WHERE name = 'find_files_call')::int                                AS ff_calls,
         COUNT(*) FILTER (WHERE name = 'find_files_call' AND props->>'found' ~ ${POSITIVE})::int   AS ff_found,
         COUNT(*) FILTER (WHERE name = 'find_files_call' AND props->>'stored' ~ ${POSITIVE})::int  AS ff_stored,
         COUNT(*) FILTER (WHERE name = 'chat_file_stored')::int                               AS stored,
         COUNT(*) FILTER (WHERE name = 'chat_file_copy_failed')::int                          AS failed
       FROM events
       WHERE ${where}`,
      params,
    )).rows[0] ?? {};
    const top = (await pg.query(
      `SELECT props->>'reason' AS reason, COUNT(*)::int AS n
         FROM events
        WHERE ${where} AND name = 'chat_file_copy_failed'
        GROUP BY 1 ORDER BY 2 DESC LIMIT 1`,
      params,
    )).rows[0];
    topFailReason = top?.reason ?? null;
  } catch {
    return null;
  }
  const bucket = await cachedBucketStats(storage);
  const n = (v: unknown) => Number(v ?? 0) || 0;
  return {
    panel: { opens: n(c.opens), users: n(c.users) },
    downloads: {
      total: n(c.downloads),
      byKind: { image: n(c.dl_image), document: n(c.dl_document), video: n(c.dl_video), audio: n(c.dl_audio) },
    },
    findFiles: { calls: n(c.ff_calls), withResults: n(c.ff_found), withStored: n(c.ff_stored) },
    storage: {
      stored: n(c.stored),
      failed: n(c.failed),
      topFailReason,
      bucketObjects: bucket?.objects ?? null,
      bucketBytes: bucket?.bytes ?? null,
    },
  };
}
