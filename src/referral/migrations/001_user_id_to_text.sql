-- 001_user_id_to_text.sql
-- Hotfix: referral_* tables объявляли user_phone / referee_phone как varchar(20),
-- рассчитанный на 11-значный телефон. После добавления email/OAuth-auth
-- (identity.service: gen_random_uuid()::text — 36 символов) первый заход
-- email-юзера на /referral падал с
--   "value too long for type character varying(20)" в getOrCreateLeader.
-- Расширяем три колонки до text — как в custom_agents.owner_user_id
-- (миграция 002_owner_user_id_to_text). Семантику и имена колонок не трогаем —
-- это сделает отдельная задача по переименованию *_phone → *_user_id.
-- Идемпотентно: если колонка уже text — ALTER пропускается через DO/EXCEPTION.

DO $$ BEGIN
  ALTER TABLE referral_leaders ALTER COLUMN user_phone TYPE text;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE referral_referees ALTER COLUMN referee_phone TYPE text;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE referral_commissions ALTER COLUMN referee_phone TYPE text;
EXCEPTION WHEN others THEN NULL; END $$;
