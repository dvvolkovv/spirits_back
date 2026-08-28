-- user_id TEXT, не varchar: у пользователей через email/OAuth идентификатор это
-- gen_random_uuid()::text (36 символов), а не телефон.
CREATE TABLE IF NOT EXISTS voice_calls (
  id             UUID PRIMARY KEY,
  user_id        TEXT NOT NULL,
  agent_id       INTEGER NOT NULL,
  room_name      TEXT NOT NULL UNIQUE,
  status         TEXT NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at       TIMESTAMPTZ,
  duration_sec   INTEGER,
  transcript     JSONB,
  summary        TEXT,
  recording_url  TEXT,
  cost_usd       NUMERIC(10,4),
  model          TEXT
);

CREATE INDEX IF NOT EXISTS voice_calls_user_started_idx
  ON voice_calls (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS voice_calls_active_idx
  ON voice_calls (status) WHERE status IN ('dialing', 'active');

CREATE TABLE IF NOT EXISTS voice_call_jobs (
  id                   UUID PRIMARY KEY,
  call_id              UUID NOT NULL REFERENCES voice_calls(id) ON DELETE CASCADE,
  specialist_agent_id  INTEGER NOT NULL,
  question             TEXT NOT NULL,
  status               TEXT NOT NULL,
  answer               TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at          TIMESTAMPTZ,
  latency_ms           INTEGER
);

CREATE INDEX IF NOT EXISTS voice_call_jobs_call_status_idx
  ON voice_call_jobs (call_id, status);
