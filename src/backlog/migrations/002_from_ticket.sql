-- 002_from_ticket.sql
-- Soft reference from a backlog item back to the support ticket that
-- triggered it. Used by the "Запрос на фичу" button in admin support and
-- by the auto-notify-user-on-done flow.

ALTER TABLE backlog_items
  ADD COLUMN IF NOT EXISTS from_ticket_id uuid;

CREATE INDEX IF NOT EXISTS idx_backlog_items_from_ticket
  ON backlog_items (from_ticket_id) WHERE from_ticket_id IS NOT NULL;
