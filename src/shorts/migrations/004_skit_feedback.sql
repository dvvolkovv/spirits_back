-- 004_skit_feedback.sql — отзыв студии о сценке, которую Omni не снять с этими репликами.
--
-- Спека: docs/superpowers/specs/2026-10-31-shorts-self-healing-design.md, «Очередь 2 → Данные».
-- План: docs/superpowers/plans/2026-11-01-shorts-self-healing-2a-writer-feedback.md, задача 1.
--
-- КАК КАТИТСЯ — как 001–003: ShortsSchemaService выполняет файл при КАЖДОМ
-- старте API, весь файл — один DO-блок (одна транзакция) под advisory-локом,
-- чужих замков ждём не дольше 5 с. Колонка — под проверкой information_schema:
-- ALTER TABLE берёт ACCESS EXCLUSIVE даже с IF NOT EXISTS и на каждом старте
-- ждал бы открытые записи (шапка 001).
--
-- ОТКАТ (код без очереди 2а колонку не читает): убрать 004 из ShortsSchemaService, затем
--   ALTER TABLE short_video DROP COLUMN skit_feedback;
DO $shorts$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('shorts/004'));
    PERFORM set_config('lock_timeout', '5s', true);
    -- Разбор отзыва студии о сценке (SkitFeedback студии, ShortSkitFeedback API): какая
    -- сценка, код, непрозвучавшие реплики, услышанное, причина отказа фильтра. Пишет студия
    -- вместе с writer_feedback (failJob), стирают сценарист, записав сценарий, новая сцена
    -- и «Повторить» с замечанием.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'short_video' AND column_name = 'skit_feedback') THEN
        ALTER TABLE short_video ADD COLUMN skit_feedback jsonb;
    END IF;
END
$shorts$;
