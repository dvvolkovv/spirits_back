-- 003_youtube.sql — автопубликация роликов на YouTube: режим, сессия загрузки, аккаунт канала.
--
-- Спека: docs/superpowers/specs/2026-10-27-shorts-youtube-autopublish-design.md, «Данные».
-- План: docs/superpowers/plans/2026-10-27-shorts-youtube-autopublish.md, задача 1.
--
-- КАК КАТИТСЯ — как 001 и 002: ShortsSchemaService выполняет файл при КАЖДОМ
-- старте API, весь файл — один DO-блок (одна транзакция) под advisory-локом,
-- чужих замков ждём не дольше 5 с. Колонки — под проверкой information_schema,
-- таблица — под to_regclass: ALTER TABLE берёт ACCESS EXCLUSIVE даже с IF NOT
-- EXISTS и на каждом старте ждал бы открытые записи (шапка 001).
--
-- ОТКАТ (код без YouTube этих колонок не читает): убрать 003 из ShortsSchemaService, затем
--   0. В боте: /youtube вручную — иначе при повторном выкате загрузка включится сразу со старым режимом и аккаунтом.
--   -- Сначала проверить канал у незавершённых загрузок — загрузка могла дойти до YouTube,
--   -- и код без YouTube на повторе пришлёт владельцу набор, а ручная выкладка даст дубль:
--   --   SELECT short_id FROM short_publication WHERE platform = 'youtube' AND upload_session IS NOT NULL;
--   DROP TABLE short_youtube_account;
--   ALTER TABLE short_publication DROP COLUMN upload_session;
--   ALTER TABLE short_settings DROP COLUMN youtube_mode;
--   -- DROP TABLE short_youtube_account доступ у Google не отзывает: при окончательном откате
--   -- отозвать его на странице https://myaccount.google.com/connections; при
--   -- повторном выкате канал подключается заново командой /youtube.
DO $shorts$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('shorts/003'));
    PERFORM set_config('lock_timeout', '5s', true);
    -- Режим YouTube: manual — набор владельцу, как до этой миграции; unlisted — «по ссылке»; public — «публично».
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'short_settings' AND column_name = 'youtube_mode') THEN
        ALTER TABLE short_settings ADD COLUMN youtube_mode text NOT NULL DEFAULT 'manual'
            CHECK (youtube_mode IN ('manual', 'unlisted', 'public'));
    END IF;
    -- Адрес resumable-сессии текущей загрузки: пишется до отправки файла, стирается после успеха.
    -- По нему повтор спрашивает YouTube, дошла ли прошлая загрузка, — без дублей на канале.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'short_publication' AND column_name = 'upload_session') THEN
        ALTER TABLE short_publication ADD COLUMN upload_session text;
    END IF;
    -- Подключённый канал — одна строка. Refresh-токен — AES-256-GCM (src/calendar/crypto.ts), как у Taler ID.
    IF to_regclass('public.short_youtube_account') IS NULL THEN
        CREATE TABLE short_youtube_account (
            id                 int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
            channel_id         text NOT NULL,
            channel_title      text,
            refresh_token_enc  text NOT NULL,
            scopes             text,
            status             text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'revoked')),
            last_error         text,
            connected_at       timestamptz NOT NULL DEFAULT now(),
            updated_at         timestamptz NOT NULL DEFAULT now()
        );
    END IF;
END
$shorts$;
