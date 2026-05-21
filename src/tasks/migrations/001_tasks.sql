-- 001_tasks.sql
-- Per-user operational tasks with LLM-extracted memory.
--
-- Cross-agent visibility: any active task surfaces in every assistant's
-- system_prompt (top-N by embedding relevance). LLM auto-creates/updates
-- tasks invisibly after each chat turn (TasksService.extractFromTurn).

CREATE TABLE IF NOT EXISTS tasks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          text NOT NULL,
  title            text NOT NULL,
  summary          text NOT NULL DEFAULT '',
  claudemd         text NOT NULL DEFAULT '',
  claudemd_locked  boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'archived', 'done')),
  last_active_at   timestamptz NOT NULL DEFAULT now(),
  embedding        double precision[] DEFAULT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_status_recent
  ON tasks (user_id, status, last_active_at DESC);

CREATE INDEX IF NOT EXISTS idx_tasks_status_archive_candidate
  ON tasks (status, last_active_at)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS task_events (
  id           bigserial PRIMARY KEY,
  task_id      uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind         text NOT NULL
                 CHECK (kind IN ('user_message','agent_response','note',
                                  'milestone','decision','status_change')),
  content      text NOT NULL,
  agent_id     int,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_events_task_created
  ON task_events (task_id, created_at DESC);
