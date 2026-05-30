-- Synthetic E2E run results — see monitoring.functions.md §Layer 2.
-- One row per (scenario, run) so we can show last result + trend.

CREATE TABLE IF NOT EXISTS synthetic_runs (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  scenario    TEXT NOT NULL,
  success     BOOLEAN NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  message     TEXT
);

CREATE INDEX IF NOT EXISTS idx_synthetic_runs_scenario_ts ON synthetic_runs (scenario, ts DESC);
CREATE INDEX IF NOT EXISTS idx_synthetic_runs_ts          ON synthetic_runs (ts DESC);
