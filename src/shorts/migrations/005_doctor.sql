-- 005_doctor.sql — самопочинка упавших роликов: код сбоя, счётчик круга и история; начало круга владельца по секундам Omni.
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
-- ОТКАТ: колонки читают и пишут claimStage API и claimJob студии (failed_code — на
-- каждом такте), разбор упавших и доктор, кнопки владельца, LIST_COLUMNS вкладки
-- «Ролики». Порядок: весь код очереди 2б — API и студия — на старый (кабинету откат
-- не нужен: новые поля он читает как необязательные); колонки можно оставить — старый
-- код их не видит. Колонки оставлены и 2б выкатывается снова — сначала стереть хвосты:
-- старый код не обнулял счётчик круга и код сбоя (доктор принял бы их за свежие) и не
-- начинал круг по секундам (omni_base остался бы от давнего круга — предел строже решённого):
--   UPDATE short_video SET failed_code = NULL, auto_recoveries = 0, omni_base = COALESCE(floor((animation->>'omniSeconds')::numeric)::int, 0)
--    WHERE failed_code IS NOT NULL OR auto_recoveries <> 0;
-- Снимать колонки — только после отката кода: убрать 005 из ShortsSchemaService, затем
--   SET lock_timeout = '5s';
--   ALTER TABLE short_video DROP COLUMN failed_code, DROP COLUMN auto_recoveries, DROP COLUMN recoveries, DROP COLUMN omni_base;
--
-- У failed_code нет CHECK — нарочно: набор кодов открытый (незнакомый код — «позже»),
-- CHECK уронил бы запись сбоя студии на первом же новом коде, и сбой потерялся бы.
-- Дописывать колонки в 005 можно, пока она не выкачена; после — только 006: проверка
-- по имени колонки молча пропустит правку уже существующей.
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
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'short_video' AND column_name = 'omni_base') THEN
        ALTER TABLE short_video ADD COLUMN omni_base integer NOT NULL DEFAULT 0;
    END IF;
END
$shorts$;
