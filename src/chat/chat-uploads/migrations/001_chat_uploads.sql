DO $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('chat-uploads/001'));
  PERFORM set_config('lock_timeout', '5s', true);
  CREATE TABLE IF NOT EXISTS chat_uploads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    session_id text NOT NULL,
    original_name text NOT NULL,
    mime text NOT NULL,
    size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    storage_key text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  IF to_regclass('idx_chat_uploads_user_session_created') IS NULL THEN
    CREATE INDEX idx_chat_uploads_user_session_created ON chat_uploads (user_id, session_id, created_at DESC);
  END IF;
  IF to_regclass('idx_chat_uploads_user_created') IS NULL THEN
    CREATE INDEX idx_chat_uploads_user_created ON chat_uploads (user_id, created_at DESC);
  END IF;
END $$;
