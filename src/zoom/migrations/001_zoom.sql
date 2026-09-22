-- 001_zoom.sql
--
-- Подключение аккаунта Zoom пользователем Linkeon — ради токена On-Behalf-Of.
--
-- ЗАЧЕМ. С 2 марта 2026 приложение на Meeting SDK может войти во встречу за
-- пределами своего аккаунта только с токеном OBF, а тот выдаётся от имени
-- пользователя, который приложение авторизовал И присутствует на встрече. Для
-- нас это удобно: ассистента зовёт именно тот, кто на встрече есть.
--
-- Одна строка на пользователя: подключение у него либо есть, либо нет.
--
-- Токены хранятся ШИФРОВАННЫМИ (AES-256-GCM, src/calendar/crypto.ts,
-- CALENDAR_SECRET_KEY) — как у подключения Taler ID. Refresh у Zoom
-- РОТИРУЕТСЯ: каждый обмен выдаёт новый и обесценивает прежний, поэтому
-- запись всегда перезаписывается целиком, а не дополняется.

CREATE TABLE IF NOT EXISTS zoom_connections (
  user_id            text PRIMARY KEY,
  zoom_user_id       text,
  zoom_account_id    text,
  refresh_token_enc  text,
  access_token_enc   text,
  access_expires_at  timestamptz,
  scopes             text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
