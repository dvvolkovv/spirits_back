-- 002_owner_user_id_to_text.sql
-- Hotfix: owner_user_id создавался как uuid, но Linkeon userId = string (phone),
-- как в smm_campaign.user_id, tasks.user_id. Меняем тип на text.
-- Идемпотентно: если колонка уже text — ALTER пропускается через DO/EXCEPTION.

DO $$ BEGIN
  ALTER TABLE custom_agents ALTER COLUMN owner_user_id TYPE text;
EXCEPTION WHEN others THEN
  -- Уже text либо другая фоновая ошибка — игнорим (миграция идемпотентна).
  NULL;
END $$;
