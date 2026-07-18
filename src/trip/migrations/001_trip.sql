CREATE TABLE IF NOT EXISTS trips (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  plan jsonb NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trip_actions (
  id bigserial PRIMARY KEY,
  trip_id text,
  user_id text,
  idem_key text UNIQUE,
  kind text,
  payload jsonb,
  created_at timestamptz DEFAULT now()
);
