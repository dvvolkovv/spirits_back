-- Разовый перенос старых листов «Чистого листа» в основные ленты
-- (spec docs/superpowers/specs/2026-11-17-context-reset-design.md, «Старые данные»;
-- проверка — src/chat/context-reset/merge-fresh-sessions.pg.spec.ts).
--
-- Раньше лист был отдельной лентой: ключ '<userId>_<ассистент>_fresh_<метка мс>'
-- в custom_chat_history, chat_uploads и action_plans. Теперь лента одна
-- ('<userId>_<ассистент>'), а «Чистый лист» — точка в chat_context_resets.
--
-- Запуск — сразу после прод-фазы deploy.sh, с OK владельца:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/oneoff/2026-11-17-merge-fresh-sessions.sql
-- Перед запуском сохранить карту для отката (что где лежало и какие были точки):
--   psql "$DATABASE_URL" -tA -F, -c "SELECT 'h', id::text, session_id FROM custom_chat_history WHERE session_id ~ '_fresh_[0-9]+$' UNION ALL SELECT 'u', id::text, session_id FROM chat_uploads WHERE session_id ~ '_fresh_[0-9]+$' UNION ALL SELECT 'p', id::text, session_id FROM action_plans WHERE session_id ~ '_fresh_[0-9]+$'" > fresh-map.csv
--   psql "$DATABASE_URL" -tA -F, -c "SELECT user_id, assistant_id, reset_at FROM chat_context_resets" > resets-before.csv
--
-- Одна транзакция: упадёт любой шаг — не изменится ничего. Повторный запуск
-- ничего не меняет. Скрипт печатает счётчики «до» и «после» и итог шага 1
-- (точек по свежим листам, давних листов без точки, свежих с неверной меткой);
-- по тегам psql видно остальное: второй SELECT n — листов людей, три UPDATE n —
-- сообщений, загрузок и планов перенесено.
--
-- Тестовые аккаунты (src/common/test-users.ts: TEST_USERS и TEST_USER_PATTERN)
-- не трогаем: их листы — пинги мониторинга, которые и после выката живут
-- изолированно.

BEGIN;

-- Чужой замок дольше 10 с — ошибка и откат целиком, а не очередь из ходов.
SET LOCAL lock_timeout = '10s';

-- Окно свежести листа — единственный параметр скрипта.
-- Зачем окно: лист жил в sessionStorage вкладки. Закрыв вкладку, человек
-- возвращался к основной памяти — давний лист не значит «в режиме», и точка по
-- нему стёрла бы ассистенту память, к которой человек уже вернулся. Точка нужна
-- тем, чья вкладка с листом, вероятно, ещё открыта: sessionStorage переживает
-- F5, а после выката обновлённая вкладка грузит новый фронт, который метку не
-- читает, — без точки человек молча выпал бы из листа. (Если такая вкладка
-- успеет сделать ход старым фронтом, точку поставит и бэк — applyLegacyFresh;
-- GREATEST сводит обе.)
-- Почему 24 часа: вкладку, где писали вчера вечером, утром обычно ещё не
-- закрыли; старше суток — скорее закрыта. Это компромисс; менять — здесь.
-- Граница включительно: ход ровно now() - 24 h — свежий.
CREATE TEMP TABLE merge_window ON COMMIT DROP AS
SELECT now() - interval '24 hours' AS fresh_since;

-- Листы людей — снимок ключей из всех трёх таблиц. Ключ разбирается строго:
-- userId (телефон или UUID) и ассистент (число или custom:<uuid>, как
-- RESET_ASSISTANT_RE в chat.controller.ts) — '_' нет ни в том, ни в другом.
-- Ключ иного вида не трогаем: он виден в счётчике «прочих».
-- ts — метка листа в мс; NULL, если неправдоподобна — те же границы, что у
-- legacyFreshResetAt (after-reset.ts): не раньше 2024-01-01 UTC и не позже
-- «сейчас + 5 минут». Такому листу точку не ставим (точка из будущего стёрла
-- бы ассистенту память навсегда), но ленту переносим. Сравнение — в numeric:
-- метка длиннее bigint не роняет скрипт.
CREATE TEMP TABLE fresh_keys ON COMMIT DROP AS
SELECT s.session_id,
       r.m[1] AS user_id,
       r.m[2] AS assistant_id,
       r.m[1] || '_' || r.m[2] AS base,
       CASE WHEN r.m[3]::numeric BETWEEN 1704067200000
                                     AND extract(epoch FROM now()) * 1000 + 300000
            THEN r.m[3]::bigint END AS ts
  FROM (SELECT session_id FROM custom_chat_history WHERE session_id ~ '_fresh_[0-9]+$'
        UNION
        SELECT session_id FROM chat_uploads WHERE session_id ~ '_fresh_[0-9]+$'
        UNION
        SELECT session_id FROM action_plans WHERE session_id ~ '_fresh_[0-9]+$') s
  CROSS JOIN LATERAL regexp_match(
    s.session_id, '^([^_]+)_([0-9]{1,12}|custom:[0-9a-f-]{36})_fresh_([0-9]+)$') AS r(m)
 WHERE r.m IS NOT NULL
   AND r.m[1] <> ALL (ARRAY['70000000000', '79030169187', '79169403771', '79656445804'])
   AND r.m[1] !~ '^790300[0-9]{5}$';

-- Счётчики — по живым таблицам: «после» показывает, что осталось на самом деле.
-- «Прочие» — тестовые аккаунты и ключи нестандартного вида; скрипт их не трогает.
-- Планы в листах после переноса могут остаться: переезжает не больше одного
-- плана на пару и только если у неё нет основного (шаг 4).
CREATE TEMP VIEW fresh_counts AS
SELECT (SELECT count(*) FROM custom_chat_history
         WHERE session_id IN (SELECT session_id FROM fresh_keys)) AS "сообщений в листах",
       (SELECT count(*) FROM chat_uploads
         WHERE session_id IN (SELECT session_id FROM fresh_keys)) AS "загрузок в листах",
       (SELECT count(*) FROM action_plans
         WHERE session_id IN (SELECT session_id FROM fresh_keys)) AS "планов в листах",
       (SELECT count(*) FROM custom_chat_history h
         WHERE h.session_id ~ '_fresh_[0-9]+$'
           AND NOT EXISTS (SELECT 1 FROM fresh_keys k WHERE k.session_id = h.session_id))
         AS "прочих сообщений _fresh_ (не трогаем)",
       (SELECT count(*) FROM chat_context_resets) AS "точек";

SELECT 'до' AS "этап", * FROM fresh_counts;

-- 1. Точка — парам, где человек на момент выката «в режиме»: его последний ход
--    у этого ассистента был в листе, строго позже последнего хода в основной
--    ленте, и не раньше окна merge_window. Ход — сообщение человека: ответы
--    без вопроса (рутины, сообщения админа, итоги звонков) пишутся в основную
--    ленту и тогда, когда человек в листе, — по ним «вышел ли он из листа» не
--    судим. Давний лист — только перенос ленты (шаги 2–4), без точки.
--    Точка = метка листа этого хода, ровно в мс: целое число мс на интервал
--    1 мс точно (метка < 2^53), без дробных секунд to_timestamp.
--    GREATEST сохраняет точку новее — например, поставленную после выката
--    старой вкладкой.
--    Итог печатается одной строкой: «точек по свежим листам» считает и пары,
--    где точка уже была (ON CONFLICT), даже если GREATEST оставил прежнюю.
WITH fresh_turn AS (
  SELECT DISTINCT ON (k.base) k.base, k.user_id, k.assistant_id, k.ts, h.created_at AS at
    FROM custom_chat_history h
    JOIN fresh_keys k ON k.session_id = h.session_id
   WHERE h.sender_type = 'human' AND h.created_at IS NOT NULL
   ORDER BY k.base, h.created_at DESC, k.ts DESC NULLS LAST
), main_turn AS (
  SELECT h.session_id AS base, max(h.created_at) AS at
    FROM custom_chat_history h
   WHERE h.sender_type = 'human'
     AND h.session_id IN (SELECT base FROM fresh_turn)
   GROUP BY h.session_id
), in_mode AS (
  -- Последний ход человека у ассистента — в листе.
  SELECT f.user_id, f.assistant_id, f.ts, f.at,
         f.at >= (SELECT fresh_since FROM merge_window) AS recent
    FROM fresh_turn f
    LEFT JOIN main_turn m USING (base)
   WHERE m.at IS NULL OR f.at > m.at
), placed AS (
  INSERT INTO chat_context_resets (user_id, assistant_id, reset_at)
  SELECT i.user_id, i.assistant_id, timestamptz 'epoch' + i.ts * interval '1 millisecond'
    FROM in_mode i
   WHERE i.recent AND i.ts IS NOT NULL
  ON CONFLICT (user_id, assistant_id) DO UPDATE
    SET reset_at = GREATEST(chat_context_resets.reset_at, EXCLUDED.reset_at)
  RETURNING 1
)
SELECT (SELECT count(*) FROM placed) AS "точек по свежим листам",
       (SELECT count(*) FROM in_mode WHERE NOT recent) AS "давних листов без точки",
       (SELECT count(*) FROM in_mode WHERE recent AND ts IS NULL) AS "свежих листов с неверной меткой";

-- 2. Сообщения листов — в основные ленты.
UPDATE custom_chat_history h
   SET session_id = k.base
  FROM fresh_keys k
 WHERE h.session_id = k.session_id;

-- 3. Загрузки — туда же: панель «Медиа и файлы» читает их по ключу ленты, а
--    удаление файла ищет строку 📎 в истории по тому же ключу.
UPDATE chat_uploads u
   SET session_id = k.base
  FROM fresh_keys k
 WHERE u.session_id = k.session_id;

-- 4. Планы: уникальность (user_id, session_id), а NOT EXISTS видит снимок до
--    UPDATE — два листа одной пары без основного плана получили бы один ключ и
--    уронили бы весь скрипт. Переносим только самый свежий план листов пары и
--    только если у пары нет основного; остальные остаются в своих листах (их
--    никто не читает, данные целы).
WITH cand AS (
  SELECT p.id, k.base,
         row_number() OVER (PARTITION BY p.user_id, k.base
                            ORDER BY p.updated_at DESC, p.id DESC) AS rn
    FROM action_plans p
    JOIN fresh_keys k ON k.session_id = p.session_id
)
UPDATE action_plans p
   SET session_id = c.base
  FROM cand c
 WHERE p.id = c.id
   AND c.rn = 1
   AND NOT EXISTS (SELECT 1 FROM action_plans q
                    WHERE q.user_id = p.user_id AND q.session_id = c.base);

SELECT 'после' AS "этап", * FROM fresh_counts;

DROP VIEW fresh_counts;

COMMIT;
