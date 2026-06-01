-- 001_backlog.sql
-- Product backlog: feature proposals admins discuss before implementing.
-- Item carries a free-form analysis (the kind of LLM/research report we
-- generate before committing engineering time), plus rough scoping fields.

CREATE TABLE IF NOT EXISTS backlog_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL,
  analysis_md  text NOT NULL DEFAULT '',
  effort       text,
  complexity   text CHECK (complexity IN ('low','medium','high')),
  costs        text,
  status       text NOT NULL DEFAULT 'proposed'
                 CHECK (status IN ('proposed','approved','in_progress','done','rejected')),
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_backlog_items_status_updated
  ON backlog_items (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS backlog_comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     uuid NOT NULL REFERENCES backlog_items(id) ON DELETE CASCADE,
  author_id   text,
  content     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_backlog_comments_item_created
  ON backlog_comments (item_id, created_at);
