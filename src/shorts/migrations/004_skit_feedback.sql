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
-- ОТКАТ: колонку читают и пишут LIST_COLUMNS, сценарист, режиссёр, «Повторить» и
-- failJob студии. Порядок: pm2 stop linkeon-studio — иначе студия 2а вернёт сценаристу
-- ещё ролик между шагами; затем два UPDATE ниже — иначе старый сценарист проведёт ролик
-- с отзывом о сценке через keepSkits (тот же текст — до трёх клипов), а после нового
-- выката 2а нестёртый отзыв сработает в чужом круге; затем весь код очереди 2а — API и
-- студия — на старый.
--   UPDATE short_video SET status = 'failed', failed_from = 'writing', lease_until = NULL,
--          failure_notified = false WHERE status = 'writing' AND skit_feedback IS NOT NULL;
--   UPDATE short_video SET skit_feedback = NULL WHERE skit_feedback IS NOT NULL;
-- Ролики, упавшие с этапа сценариста на отзыве о сценке (в writer_feedback — текст
-- студии о сценке), на старом коде повторять только с замечанием или «Новой сценой»:
-- без замечания старый сценарист оставит сценку, и студия снимет тот же текст.
-- Колонку можно и оставить — старый код её не видит. Снять: убрать 004 из
-- ShortsSchemaService, затем
--   SET lock_timeout = '5s'; ALTER TABLE short_video DROP COLUMN skit_feedback;
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
