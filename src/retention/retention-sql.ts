import { RETENTION_UID_SQL_RE } from './retention-recipient';

const UID = `split_part(session_id,'_',1) ~ '${RETENTION_UID_SQL_RE}'`;
const TG_UID = `tc.owner_user_id ~ '${RETENTION_UID_SQL_RE}'`;

export const GENERAL_SEGMENT_SQL = `WITH last_chat AS (
  SELECT split_part(session_id,'_',1) AS uid, split_part(session_id,'_',2) AS assistant_id, max(created_at) AS last_at
    FROM custom_chat_history
   WHERE sender_type='human' AND ${UID}
     AND split_part(session_id,'_',1) <> ALL($1) AND split_part(session_id,'_',1) !~ $2
   GROUP BY 1,2
  UNION ALL
  SELECT tc.owner_user_id AS uid, COALESCE(tc.preset_agent_id,'') AS assistant_id, max(m.created_at) AS last_at
    FROM tg_bot_messages m JOIN tg_bot_configs tc ON tc.id=m.config_id
   WHERE m.role='user' AND ${TG_UID}
     AND tc.owner_user_id <> ALL($1) AND tc.owner_user_id !~ $2
   GROUP BY 1,2
), per_user AS (
  SELECT DISTINCT ON (uid) uid, assistant_id, last_at FROM last_chat ORDER BY uid, last_at DESC
)
SELECT pu.uid AS user_id, pu.assistant_id, pu.last_at,
       COALESCE(a.display_name,a.name) AS assistant_name,
       EXTRACT(DAY FROM now()-pu.last_at)::int AS days_inactive
  FROM per_user pu
  LEFT JOIN agents a ON a.id=CASE WHEN pu.assistant_id ~ '^[0-9]+$' THEN pu.assistant_id::int END
 WHERE pu.last_at < now()-make_interval(days => $3)
   AND pu.last_at > now()-make_interval(days => $4)
 ORDER BY pu.last_at DESC`;

export const CURIOUS_SEGMENT_SQL = `WITH last_chat AS (
  SELECT uid, max(last_at) AS last_at FROM (
    SELECT split_part(session_id,'_',1) AS uid, max(created_at) AS last_at
      FROM custom_chat_history
     WHERE sender_type='human' AND ${UID}
       AND split_part(session_id,'_',1) <> ALL($1) AND split_part(session_id,'_',1) !~ $2
     GROUP BY 1
    UNION ALL
    SELECT tc.owner_user_id AS uid, max(m.created_at) AS last_at
      FROM tg_bot_messages m JOIN tg_bot_configs tc ON tc.id=m.config_id
     WHERE m.role='user' AND ${TG_UID}
       AND tc.owner_user_id <> ALL($1) AND tc.owner_user_id !~ $2
     GROUP BY 1
  ) src GROUP BY 1
), msgcnt AS (
  SELECT user_id, SUM(n) AS n FROM (
    SELECT user_id, COUNT(*) AS n FROM events WHERE name='message_sent' GROUP BY 1
    UNION ALL
    SELECT tc.owner_user_id AS user_id, COUNT(*) AS n
      FROM tg_bot_messages m JOIN tg_bot_configs tc ON tc.id=m.config_id
     WHERE m.role='user' GROUP BY 1
  ) src GROUP BY 1
)
SELECT lc.uid AS user_id, lc.last_at,
       round(EXTRACT(EPOCH FROM now()-lc.last_at)/3600.0)::int AS hours_inactive
  FROM last_chat lc JOIN msgcnt mc ON mc.user_id=lc.uid
 WHERE lc.last_at < now()-interval '24 hours'
   AND lc.last_at > now()-interval '48 hours'
   AND mc.n < 5
   AND lc.uid NOT IN (SELECT user_id FROM ai_profiles_consolidated WHERE isadmin=true)
 ORDER BY lc.last_at DESC`;
