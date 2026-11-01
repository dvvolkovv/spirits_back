-- 005_doctor.sql — самопочинка упавших роликов: код сбоя, счётчик круга и история.
--
-- Спека: docs/superpowers/specs/2026-10-31-shorts-self-healing-design.md, «Очередь 2 → Доктор», «Данные».
-- План: docs/superpowers/plans/2026-11-01-shorts-self-healing-2b-doctor.md, задача 1.
--
-- КАК КАТИТСЯ — как 001–004: ShortsSchemaService выполняет файл при КАЖДОМ
-- старте API, весь файл — один DO-блок (одна транзакция) под advisory-локом,
-- чужих замков ждём не дольше 5 с. Колонки — под проверкой information_schema:
-- ALTER TABLE берёт ACCESS EXCLUSIVE даже с IF NOT EXISTS и на каждом старте
-- ждал бы открытые записи (шапка 001). Умолчания — константы: Postgres не
-- переписывает таблицу.
--
-- ОТКАТ: весь код очереди 2б — API, студия и кабинет — на старый; колонки можно
-- оставить: старый код их не видит. Снимать колонки — только после отката кода
-- (студия и API 2б пишут их на каждом сбое): убрать 005 из ShortsSchemaService, затем
--   SET lock_timeout = '5s';
--   ALTER TABLE short_video DROP COLUMN failed_code, DROP COLUMN auto_recoveries, DROP COLUMN recoveries;
DO $shorts$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('shorts/005'));
    PERFORM set_config('lock_timeout', '5s', true);
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'short_video' AND column_name = 'failed_code') THEN
        ALTER TABLE short_video ADD COLUMN failed_code text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'short_video' AND column_name = 'auto_recoveries') THEN
        ALTER TABLE short_video ADD COLUMN auto_recoveries integer NOT NULL DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'short_video' AND column_name = 'recoveries') THEN
        ALTER TABLE short_video ADD COLUMN recoveries jsonb NOT NULL DEFAULT '[]'::jsonb;
    END IF;
END
$shorts$;
