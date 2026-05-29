-- Universal product events table.
-- Single source of truth for the funnel, activation, and other product metrics
-- in /admin/monitoring/product. See monitoring.functions.md §3.8 for the
-- canonical event list.

CREATE TABLE IF NOT EXISTS events (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id     TEXT,                          -- nullable: anonymous landing visits
  session_id  TEXT,                          -- anonymous funnel correlation
  name        TEXT NOT NULL,                 -- 'landing_view', 'signup_completed', ...
  props       JSONB NOT NULL DEFAULT '{}'::jsonb,
  source      TEXT,                          -- 'organic' | 'referral:<slug>' | 'utm:<campaign>' | ...
  cohort_week DATE GENERATED ALWAYS AS ((date_trunc('week', ts))::date) STORED
);

CREATE INDEX IF NOT EXISTS idx_events_ts        ON events (ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_name_ts   ON events (name, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_user_ts   ON events (user_id, ts DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_session   ON events (session_id, ts) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_cohort    ON events (cohort_week, name);
