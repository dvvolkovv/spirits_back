-- 001_peer_tables.sql
-- User-to-user chat requests + 1:1 conversations

CREATE TABLE IF NOT EXISTS chat_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id   text NOT NULL,
  to_user_id     text NOT NULL,
  intro_message  text NOT NULL CHECK (char_length(intro_message) <= 500),
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','accepted','declined','withdrawn')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  responded_at   timestamptz,
  CHECK (from_user_id <> to_user_id)
);

-- Only one active pending request between a given pair
CREATE UNIQUE INDEX IF NOT EXISTS uniq_chat_requests_pending
  ON chat_requests (from_user_id, to_user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_chat_requests_to_status
  ON chat_requests (to_user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_requests_from_status
  ON chat_requests (from_user_id, status, created_at DESC);


CREATE TABLE IF NOT EXISTS peer_conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a_id       text NOT NULL,
  user_b_id       text NOT NULL,
  request_id      uuid REFERENCES chat_requests(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz,
  CHECK (user_a_id < user_b_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_peer_conversations_pair
  ON peer_conversations (user_a_id, user_b_id);

CREATE INDEX IF NOT EXISTS idx_peer_conversations_user_a_last
  ON peer_conversations (user_a_id, last_message_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_peer_conversations_user_b_last
  ON peer_conversations (user_b_id, last_message_at DESC NULLS LAST);


CREATE TABLE IF NOT EXISTS peer_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES peer_conversations(id) ON DELETE CASCADE,
  sender_id       text NOT NULL,
  content         text NOT NULL CHECK (char_length(content) <= 4000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  read_at         timestamptz
);

CREATE INDEX IF NOT EXISTS idx_peer_messages_conv_created
  ON peer_messages (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_peer_messages_unread
  ON peer_messages (conversation_id, sender_id)
  WHERE read_at IS NULL;


CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id text NOT NULL,
  blocked_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked
  ON user_blocks (blocked_id);


CREATE TABLE IF NOT EXISTS user_reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id   text NOT NULL,
  target_id     text NOT NULL,
  reason        text NOT NULL,
  context_type  text,
  context_id    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (reporter_id <> target_id)
);

CREATE INDEX IF NOT EXISTS idx_user_reports_target
  ON user_reports (target_id, created_at DESC);
