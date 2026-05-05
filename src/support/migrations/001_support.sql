-- 001_support.sql
-- AI-first support: tickets, messages, events, service health snapshot.

CREATE TABLE IF NOT EXISTS support_tickets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            text NOT NULL,
  status             text NOT NULL DEFAULT 'ai_handling'
                       CHECK (status IN ('ai_handling','escalated','owner_handling','resolved','closed')),
  urgency            text CHECK (urgency IN ('low','normal','high','critical')),
  topic              text,
  escalation_reason  text,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  last_message_at    timestamptz,
  resolved_at        timestamptz
);

-- Only one active (non-terminal) ticket per user at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_support_tickets_active_per_user
  ON support_tickets (user_id)
  WHERE status IN ('ai_handling','escalated','owner_handling');

CREATE INDEX IF NOT EXISTS idx_support_tickets_status_updated
  ON support_tickets (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_tickets_user_created
  ON support_tickets (user_id, created_at DESC);


CREATE TABLE IF NOT EXISTS support_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id        uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender_type      text NOT NULL CHECK (sender_type IN ('user','ai','owner','system')),
  sender_id        text,
  content          text NOT NULL,
  metadata         jsonb,
  visible_to_user  boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_messages_ticket_created
  ON support_messages (ticket_id, created_at ASC);


CREATE TABLE IF NOT EXISTS support_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  actor_type  text NOT NULL CHECK (actor_type IN ('ai','owner','system')),
  actor_id    text,
  action      text NOT NULL,
  payload     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_events_ticket
  ON support_events (ticket_id, created_at ASC);


CREATE TABLE IF NOT EXISTS service_health (
  service        text PRIMARY KEY,
  status         text NOT NULL CHECK (status IN ('healthy','degraded','down','unknown')) DEFAULT 'unknown',
  latency_ms     int,
  last_check_at  timestamptz NOT NULL DEFAULT now(),
  last_error     text,
  details        jsonb
);
