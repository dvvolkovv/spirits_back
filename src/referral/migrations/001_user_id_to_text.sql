-- 001_user_id_to_text.sql
-- Hotfix: referral_* tables объявляли user_phone / referee_phone как varchar(20),
-- рассчитанный на 11-значный телефон. После добавления email/OAuth-auth
-- (identity.service: gen_random_uuid()::text — 36 символов) первый заход
-- email-юзера на /referral падал с
--   "value too long for type character varying(20)" в getOrCreateLeader.
-- Расширяем три колонки до text — как в custom_agents.owner_user_id
-- (миграция 002_owner_user_id_to_text). Семантику и имена колонок не трогаем —
-- это сделает отдельная задача по переименованию *_phone → *_user_id.
-- Идемпотентно: колонка, уже ставшая text, не трогается.
--
-- K2 (17.11.2026). Файл накатывается на КАЖДОМ старте API (ReferralService.
-- applyMigration). Прежняя форма — безусловный ALTER в DO/EXCEPTION WHEN
-- others — брала ACCESS EXCLUSIVE на все три таблицы при каждом старте:
-- ALTER TABLE берёт лок раньше, чем видит, что колонка уже text. Ждала лок
-- без lock_timeout (старт висел за любой открытой транзакцией на таблице, а
-- за стартом — все запросы к ней) и молча глотала любую ошибку. С 17C от
-- этих колонок зависит referral.purge: alias 'deleted:<uuid>' в varchar(20)
-- не помещается.
--
-- Теперь колонка проверяется по каталогу ДО ALTER — на актуальной схеме лок
-- не просится вовсе; ожидание лока ограничено 5 с (форма
-- chat-uploads/001); ошибка, включая таймаут, доходит до applyMigration и
-- пишется в лог. Один DO — один оператор и одна транзакция: не дождался
-- любой из таблиц — не применено ничего, следующий старт повторит целиком.

DO $$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'referral_leaders'
                AND column_name = 'user_phone'
                AND data_type <> 'text') THEN
    ALTER TABLE referral_leaders ALTER COLUMN user_phone TYPE text;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'referral_referees'
                AND column_name = 'referee_phone'
                AND data_type <> 'text') THEN
    ALTER TABLE referral_referees ALTER COLUMN referee_phone TYPE text;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'referral_commissions'
                AND column_name = 'referee_phone'
                AND data_type <> 'text') THEN
    ALTER TABLE referral_commissions ALTER COLUMN referee_phone TYPE text;
  END IF;
END $$;
