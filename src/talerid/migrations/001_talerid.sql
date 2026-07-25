-- 001_talerid.sql
-- Per-user TalerID partner connection: OAuth-rotation-safe token store.
--
-- One row per Linkeon user (PRIMARY KEY user_id — a user has at most one TalerID
-- connection). Tokens are stored encrypted (AES-256-GCM, src/calendar/crypto.ts,
-- CALENDAR_SECRET_KEY) — never plaintext at rest. Refresh rotates on every
-- oauth/token exchange (TalerIdOauthClient.refresh) — updateRefresh atomically
-- overwrites so a stale refresh is never reused (reuse revokes the whole chain).

CREATE TABLE IF NOT EXISTS talerid_connections (
  user_id            text PRIMARY KEY,
  talerid_user_id    text,
  refresh_token_enc  text,
  access_token_enc   text,
  access_expires_at  timestamptz,
  scopes             text,
  status             text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
