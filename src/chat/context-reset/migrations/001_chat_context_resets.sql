-- «Чистый лист» — точка отсчёта памяти ассистента (spec 2026-11-17-context-reset).
-- Одна строка на пару «пользователь + ассистент»: значение имеет только последняя точка.
DO $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('chat-context-resets/001'));
  PERFORM set_config('lock_timeout', '5s', true);
  CREATE TABLE IF NOT EXISTS chat_context_resets (
    user_id text NOT NULL,
    assistant_id text NOT NULL,
    reset_at timestamptz NOT NULL,
    PRIMARY KEY (user_id, assistant_id)
  );
END $$;
