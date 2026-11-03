-- 002_support_sla.sql

ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS assigned_to text;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS assigned_at timestamptz;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS first_response_due_at timestamptz;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS first_owner_reply_at timestamptz;

UPDATE support_tickets t
SET first_response_due_at = COALESCE(
  (
    SELECT min(e.created_at)
    FROM support_events e
    WHERE e.ticket_id = t.id AND e.action = 'escalate'
  ),
  t.created_at
) + CASE COALESCE(t.urgency, 'normal')
  WHEN 'critical' THEN interval '15 minutes'
  WHEN 'high' THEN interval '1 hour'
  WHEN 'low' THEN interval '24 hours'
  ELSE interval '4 hours'
END
WHERE t.first_response_due_at IS NULL;

UPDATE support_tickets t
SET first_owner_reply_at = (
  SELECT min(m.created_at)
  FROM support_messages m
  WHERE m.ticket_id = t.id
    AND m.sender_type = 'owner'
    AND m.visible_to_user = true
)
WHERE t.first_owner_reply_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_support_tickets_first_response_due_at
  ON support_tickets (first_response_due_at);

CREATE INDEX IF NOT EXISTS idx_support_tickets_assigned_to
  ON support_tickets (assigned_to);
