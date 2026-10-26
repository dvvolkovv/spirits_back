-- 002_skits.sql — ролики со сценками: формат ролика, оживление, статусы этапа animate.
--
-- Спека: docs/superpowers/specs/2026-10-26-shorts-skits-design.md, «Данные».
-- План: docs/superpowers/plans/2026-10-26-shorts-skits-2-pipeline.md, задача 1.
--
-- КАК КАТИТСЯ — как 001: ShortsSchemaService выполняет файл при КАЖДОМ старте
-- API, весь файл — один DO-блок (одна транзакция) под advisory-локом, чужих
-- замков ждём не дольше 5 с. Каждое изменение — под проверкой каталога:
-- ALTER TABLE берёт ACCESS EXCLUSIVE даже с IF NOT EXISTS и на каждом старте
-- ждал бы открытые записи (шапка 001).
--
-- ОТКАТ: убрать 002 из ShortsSchemaService, ролики в animate_queued и animating
-- перевести в failed, затем
--   ALTER TABLE short_video DROP COLUMN format, DROP COLUMN animation;
--   ALTER TABLE short_settings DROP COLUMN format, DROP COLUMN max_omni_seconds;
--   и вернуть CHECK статуса списком из 001.

DO $shorts$
DECLARE
    c record;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('shorts/002'));
    PERFORM set_config('lock_timeout', '5s', true);

    -- Ролики, запущенные до сценок, сняты по-старому: колонка приходит со
    -- значением 'chat', затем умолчание меняется на 'skit'. Сам формат ролику
    -- ставит запуск — из настроек (shorts-topic.service.ts, start).
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'short_video' AND column_name = 'format') THEN
        ALTER TABLE short_video ADD COLUMN format text NOT NULL DEFAULT 'chat' CHECK (format IN ('skit', 'chat'));
        ALTER TABLE short_video ALTER COLUMN format SET DEFAULT 'skit';
    END IF;
    -- Итог задания animate: секунды Omni, кадры, клипы сценок (studio/src/types.ts, ShortAnimation).
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'short_video' AND column_name = 'animation') THEN
        ALTER TABLE short_video ADD COLUMN animation jsonb;
    END IF;

    -- Статусы этапа animate: CHECK пересоздаётся, только пока в нём их нет.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.short_video'::regclass AND contype = 'c'
                      AND pg_get_constraintdef(oid) LIKE '%''animating''%') THEN
        FOR c IN SELECT conname FROM pg_constraint
                  WHERE conrelid = 'public.short_video'::regclass AND contype = 'c'
                    AND pg_get_constraintdef(oid) LIKE '%''render_queued''%'
        LOOP
            EXECUTE format('ALTER TABLE short_video DROP CONSTRAINT %I', c.conname);
        END LOOP;
        ALTER TABLE short_video ADD CONSTRAINT short_video_status_check CHECK (status IN (
            'idea', 'directing', 'capture_queued', 'capturing', 'writing',
            'animate_queued', 'animating', 'render_queued', 'rendering', 'pending_review', 'approved',
            'publishing', 'published', 'rejected', 'failed'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'short_settings' AND column_name = 'format') THEN
        ALTER TABLE short_settings ADD COLUMN format text NOT NULL DEFAULT 'skit' CHECK (format IN ('skit', 'chat'));
    END IF;
    -- Предел секунд Omni на ролик: 48 с — шесть клипов, ≈ $4,8 (спека, «Отказы»).
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'short_settings' AND column_name = 'max_omni_seconds') THEN
        ALTER TABLE short_settings ADD COLUMN max_omni_seconds int NOT NULL DEFAULT 48
            CHECK (max_omni_seconds BETWEEN 8 AND 400);
    END IF;
END
$shorts$;
