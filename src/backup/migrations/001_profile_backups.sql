-- A6 §4.2.1 — слепое хранилище зашифрованной копии профиля.
-- Сервер держит ТОЛЬКО шифротекст (bytea), ключа нет и прочитать нельзя.
-- Одна текущая копия на пользователя + одна предыдущая: страховка от того,
-- что битая/пустая загрузка затрёт единственную хорошую копию (данные не теряем).
CREATE TABLE IF NOT EXISTS profile_backups (
  user_id          TEXT PRIMARY KEY,
  blob             BYTEA       NOT NULL,
  size_bytes       INTEGER     NOT NULL,
  format           INTEGER     NOT NULL DEFAULT 1,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  prev_blob        BYTEA,
  prev_size_bytes  INTEGER,
  prev_updated_at  TIMESTAMPTZ
);
