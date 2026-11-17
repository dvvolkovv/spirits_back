-- Откат разового переноса листов «Чистого листа»
-- (scripts/oneoff/2026-11-17-merge-fresh-sessions.sql; проверка —
-- src/chat/context-reset/merge-fresh-sessions.pg.spec.ts).
--
-- Одна транзакция:
-- 1. Ленты: каждая строка из карты oneoff_20261117_fresh_map, которая всё ещё
--    лежит в основной ленте, возвращается в свой лист (session_id || fresh_suffix).
-- 2. Точки по аудиту oneoff_20261117_resets_audit: прежнее значение
--    возвращается, а если точки не было — она удаляется, ТОЛЬКО если текущее
--    значение равно поставленному переносом (new_reset_at). Точки, которые
--    люди сдвинули после переноса, не трогаем.
-- Повторный откат ничего не меняет: строки уже в листах, точки уже не равны
-- new_reset_at.
--
-- Откат имеет смысл вместе с откатом выката: новый бэк и фронт ленту листа не
-- показывают, его читают только старые (по freshTs).
--
-- Запуск (U — DATABASE_URL, как в шапке переноса):
--   psql "$U" -v ON_ERROR_STOP=1 -f scripts/oneoff/2026-11-17-merge-fresh-sessions-rollback.sql
-- Прогон без последствий — с ROLLBACK вместо COMMIT:
--   sed 's/^COMMIT;$/ROLLBACK;/' scripts/oneoff/2026-11-17-merge-fresh-sessions-rollback.sql | psql "$U" -v ON_ERROR_STOP=1
--
-- Карта и аудит после отката остаются — для разбора. Удалить отдельной
-- командой, когда больше не нужны, и в любом случае через 7 дней после
-- успешного выката (в аудите user_id):
--   psql "$U" -c 'DROP TABLE oneoff_20261117_fresh_map, oneoff_20261117_resets_audit'

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- Одно выражение: итог — одной строкой. MATERIALIZED — чтобы row_id
-- приводился к типу id только у строк своего вида ('h' — integer, 'u' и
-- 'p' — uuid), а не у всей карты.
WITH hm AS MATERIALIZED (
  SELECT row_id::integer AS id, fresh_suffix FROM oneoff_20261117_fresh_map WHERE kind = 'h'
), h AS (
  UPDATE custom_chat_history t
     SET session_id = t.session_id || hm.fresh_suffix
    FROM hm
   WHERE t.id = hm.id AND t.session_id !~ '_fresh_[0-9]+$'
  RETURNING 1
), um AS MATERIALIZED (
  SELECT row_id::uuid AS id, fresh_suffix FROM oneoff_20261117_fresh_map WHERE kind = 'u'
), u AS (
  UPDATE chat_uploads t
     SET session_id = t.session_id || um.fresh_suffix
    FROM um
   WHERE t.id = um.id AND t.session_id !~ '_fresh_[0-9]+$'
  RETURNING 1
), pm AS MATERIALIZED (
  SELECT row_id::uuid AS id, fresh_suffix FROM oneoff_20261117_fresh_map WHERE kind = 'p'
), p AS (
  UPDATE action_plans t
     SET session_id = t.session_id || pm.fresh_suffix
    FROM pm
   WHERE t.id = pm.id AND t.session_id !~ '_fresh_[0-9]+$'
  RETURNING 1
), restored AS (
  UPDATE chat_context_resets r
     SET reset_at = a.old_reset_at
    FROM oneoff_20261117_resets_audit a
   WHERE r.user_id = a.user_id AND r.assistant_id = a.assistant_id
     AND r.reset_at = a.new_reset_at AND a.old_reset_at IS NOT NULL
  RETURNING 1
), removed AS (
  DELETE FROM chat_context_resets r
   USING oneoff_20261117_resets_audit a
   WHERE r.user_id = a.user_id AND r.assistant_id = a.assistant_id
     AND r.reset_at = a.new_reset_at AND a.old_reset_at IS NULL
  RETURNING 1
)
SELECT (SELECT count(*) FROM h) AS "сообщений возвращено в листы",
       (SELECT count(*) FROM u) AS "загрузок возвращено",
       (SELECT count(*) FROM p) AS "планов возвращено",
       (SELECT count(*) FROM restored) AS "точек возвращено",
       (SELECT count(*) FROM removed) AS "точек удалено",
       -- По снимку до этого выражения: точка есть, но уже не та, что
       -- поставил перенос, и не прежняя.
       (SELECT count(*) FROM oneoff_20261117_resets_audit a
          JOIN chat_context_resets r USING (user_id, assistant_id)
         WHERE r.reset_at <> a.new_reset_at
           AND r.reset_at IS DISTINCT FROM a.old_reset_at) AS "точек не тронуто (сдвинуты позже)";

COMMIT;
