CREATE TABLE IF NOT EXISTS retention_email_unsubscribes (
  email_normalized text PRIMARY KEY,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  unsubscribed_at timestamptz
);
