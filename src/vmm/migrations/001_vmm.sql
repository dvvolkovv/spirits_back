-- 001_vmm.sql
-- Virtual Marketing Manager («виртуальный маркетолог»): хранимые прогоны
-- LLM-обзора маркетинга + отдельные рекомендации, которые оператор может
-- одобрить (→ задача в бэклоге продукта) или отклонить. Симметрично vpm_*.

CREATE TABLE IF NOT EXISTS vmm_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  triggered_by    text,                    -- admin user_id, NULL for cron
  trigger         text NOT NULL DEFAULT 'manual'
                    CHECK (trigger IN ('manual','cron')),
  snapshot        jsonb NOT NULL,          -- raw marketing metrics shown to the LLM
  cost_usd        numeric(10, 6),
  duration_ms     int,
  error_message   text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vmm_runs_created ON vmm_runs (created_at DESC);

CREATE TABLE IF NOT EXISTS vmm_recommendations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              uuid NOT NULL REFERENCES vmm_runs(id) ON DELETE CASCADE,
  priority            text NOT NULL DEFAULT 'medium'
                        CHECK (priority IN ('critical','high','medium','low')),
  title               text NOT NULL,
  rationale_md        text NOT NULL DEFAULT '',
  proposed_action_md  text NOT NULL DEFAULT '',
  related_metrics     jsonb NOT NULL DEFAULT '[]'::jsonb,
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','in_backlog','dismissed','done')),
  backlog_item_id     uuid,                -- soft FK to backlog_items.id
  status_changed_at   timestamptz,
  status_changed_by   text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vmm_recommendations_status ON vmm_recommendations (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vmm_recommendations_run    ON vmm_recommendations (run_id);
