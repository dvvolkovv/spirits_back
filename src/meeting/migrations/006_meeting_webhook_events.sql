CREATE TABLE IF NOT EXISTS meeting_webhook_events (
  id               BIGSERIAL PRIMARY KEY,
  call_id          UUID NOT NULL REFERENCES voice_calls(id) ON DELETE CASCADE,
  idempotency_key  TEXT,
  trigger          TEXT NOT NULL,
  message          JSONB NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'processing', 'delivered', 'discarded', 'dead')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_retry_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS meeting_webhook_events_key_idx
  ON meeting_webhook_events (call_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS meeting_webhook_events_due_idx
  ON meeting_webhook_events (next_retry_at, created_at, id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS meeting_webhook_events_stale_idx
  ON meeting_webhook_events (updated_at)
  WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS meeting_webhook_events_call_idx
  ON meeting_webhook_events (call_id);
CREATE INDEX IF NOT EXISTS meeting_webhook_events_retention_idx
  ON meeting_webhook_events (updated_at)
  WHERE status IN ('delivered', 'discarded', 'dead');
