-- Разовый перенос старых листов «Чистого листа» в основные ленты
-- (spec docs/superpowers/specs/2026-11-17-context-reset-design.md, «Старые данные»;
-- проверка — src/chat/context-reset/merge-fresh-sessions.pg.spec.ts;
-- откат — scripts/oneoff/2026-11-17-merge-fresh-sessions-rollback.sql).
--
-- Раньше лист был отдельной лентой: ключ '<userId>_<ассистент>_fresh_<метка мс>'
-- в custom_chat_history, chat_uploads и action_plans. Теперь лента одна
-- ('<userId>_<ассистент>'), а «Чистый лист» — точка в chat_context_resets.
--
-- Где взять DATABASE_URL на сервере: в интерактивном ssh ~/.profile не
-- читается — строку берём из .env живого чекаута (последняя DATABASE_URL=):
--   U=$(sed -n -E 's/^[[:space:]]*(export[[:space:]]+)?DATABASE_URL[[:space:]]*=[[:space:]]*//p' ~/spirits_back/.env | tail -n 1 | sed -E -e 's/[[:space:]]+$//' -e 's/^"(.*)"$/\1/' -e "s/^'(.*)'\$/\1/")
--
-- Порядок (команды — из ~/spirits_back на сервере). Пробный прогон на проде
-- до выката невозможен: таблицу chat_context_resets создаёт стартовая
-- миграция нового бэка, да и этого файла в прод-чекауте до выката нет.
-- (а) После TEST-фазы deploy.sh — пробный прогон на test.linkeon.io: всё то
--     же, но в конце ROLLBACK; ничего не меняет, печатает счётчики:
--       sed 's/^COMMIT;$/ROLLBACK;/' scripts/oneoff/2026-11-17-merge-fresh-sessions.sql | psql "$U" -v ON_ERROR_STOP=1
--     затем боевой перенос на test — командой из (в).
-- (б) До deploy.sh — подсчёт листов людей на проде, только чтение (сессия
--     read-only: запись база отвергнет); таблица точек ему не нужна. Список
--     тестовых аккаунтов — копия того, что в скрипте ниже. Нет таблицы
--     chat_uploads — убрать её звено из UNION.
--       PGOPTIONS='-c default_transaction_read_only=on' psql "$U" -c "SELECT t AS таблица, count(*) AS строк, count(DISTINCT s) AS листов, count(DISTINCT s) FILTER (WHERE at >= now() - interval '24 hours') AS листов_за_сутки FROM (SELECT 'история' t, session_id s, created_at at FROM custom_chat_history UNION ALL SELECT 'загрузки', session_id, created_at FROM chat_uploads UNION ALL SELECT 'планы', session_id, updated_at FROM action_plans) x WHERE s ~ '^[^_]+_([0-9]{1,12}|custom:[0-9a-f-]{36})_fresh_[0-9]+$' AND split_part(s, '_', 1) NOT IN ('70000000000', '79030169187', '79169403771', '79656445804') AND NOT split_part(s, '_', 1) ~ '^790300[0-9]{5}$' GROUP BY 1 ORDER BY 1"
--     «листов_за_сутки» у истории — верхняя оценка числа точек. По (б) — OK
--     владельца одним пакетом (план, раздел «Выкат», шаг 0); (а) — уже в нём.
-- (в) Как только прод-бэк перезапущен (по журналу deploy.sh, не дожидаясь
--     прод-смоука) — пробный прогон на проде (команда из (а)); если цифры
--     в пределах ожидаемого по (б) — перенос:
--       psql "$U" -v ON_ERROR_STOP=1 -f scripts/oneoff/2026-11-17-merge-fresh-sessions.sql
--
-- Одна транзакция: упадёт любой шаг — не изменится ничего (и карты не будет).
-- Повторный запуск ничего не меняет и ничего не дублирует. Если живой
-- «Обновить план» вставит основной план той же пары во время скрипта, шаг 4
-- упадёт на уникальности — откатится всё, повтор безопасен.
--
-- Карта отката и аудит точек пишутся в базу в той же транзакции:
--   oneoff_20261117_fresh_map    — (kind 'h'|'u'|'p', row_id, fresh_suffix
--     '_fresh_<метка>', moved_at): по строке на каждую перенесённую строку.
--     Телефонов и ключей целиком нет: после переноса session_id равен основе,
--     откат — session_id || fresh_suffix.
--   oneoff_20261117_resets_audit — (user_id, assistant_id, old_reset_at,
--     new_reset_at): по паре, которой скрипт поставил или сдвинул точку
--     (old_reset_at NULL — точки не было).
-- Перед повторным переносом после отката — DROP TABLE oneoff_20261117_resets_audit:
-- иначе аудит хранит old_reset_at и new_reset_at первого прогона (ON CONFLICT
-- DO NOTHING), и второй откат по нему вернёт не то.
-- Обе таблицы удалить через 7 дней после успешного выката (в аудите user_id):
--   psql "$U" -c 'DROP TABLE oneoff_20261117_fresh_map, oneoff_20261117_resets_audit'
--
-- Что печатает: счётчики «до» и «после» и итог шага 1 (точек поставлено или
-- сдвинуто, давних листов без точки, свежих с неверной меткой, удалённых
-- аккаунтов без точки). «Прочие» — листы тестовых аккаунтов и ключи
-- нестандартного вида, скрипт их не трогает; «до» и «после» у них могут
-- разойтись из-за живых пингов мониторинга — это не ошибка.
--
-- Тестовые аккаунты (src/common/test-users.ts: TEST_USERS и TEST_USER_PATTERN;
-- копию сторожит спек) не трогаем: их листы — пинги мониторинга, которые и
-- после выката живут изолированно.

BEGIN;

-- Чужой замок дольше 10 с или выражение дольше 2 минут — ошибка и откат
-- целиком, а не очередь из ходов за долгой транзакцией.
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

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

-- Карта отката и аудит точек (см. шапку). IF NOT EXISTS — для повторного
-- запуска; ключи не дают задублировать записи.
CREATE TABLE IF NOT EXISTS oneoff_20261117_fresh_map (
  kind text NOT NULL CHECK (kind IN ('h', 'u', 'p')),
  row_id text NOT NULL,
  fresh_suffix text NOT NULL CHECK (fresh_suffix ~ '^_fresh_[0-9]+$'),
  moved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, row_id)
);
CREATE TABLE IF NOT EXISTS oneoff_20261117_resets_audit (
  user_id text NOT NULL,
  assistant_id text NOT NULL,
  old_reset_at timestamptz,
  new_reset_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, assistant_id)
);

-- Листы людей — снимок ключей из всех трёх таблиц. Ключ разбирается строго:
-- userId (телефон или UUID) и ассистент (число или custom:<uuid>, как
-- RESET_ASSISTANT_RE в chat.controller.ts) — '_' нет ни в том, ни в другом.
-- Ключ иного вида не трогаем: он виден в счётчиках «прочих».
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
ANALYZE fresh_keys;

-- Счётчики — по живым таблицам: «после» показывает, что осталось на самом деле.
-- Планы в листах после переноса могут остаться: переезжает не больше одного
-- плана на пару и только если у неё нет основного (шаг 4).
CREATE TEMP VIEW fresh_counts AS
SELECT (SELECT count(*) FROM custom_chat_history
         WHERE session_id IN (SELECT session_id FROM fresh_keys)) AS "сообщений в листах",
       (SELECT count(*) FROM chat_uploads
         WHERE session_id IN (SELECT session_id FROM fresh_keys)) AS "загрузок в листах",
       (SELECT count(*) FROM action_plans
         WHERE session_id IN (SELECT session_id FROM fresh_keys)) AS "планов в листах",
       (SELECT count(*) FROM custom_chat_history t
         WHERE t.session_id ~ '_fresh_[0-9]+$'
           AND NOT EXISTS (SELECT 1 FROM fresh_keys k WHERE k.session_id = t.session_id))
         AS "прочих сообщений _fresh_",
       (SELECT count(*) FROM chat_uploads t
         WHERE t.session_id ~ '_fresh_[0-9]+$'
           AND NOT EXISTS (SELECT 1 FROM fresh_keys k WHERE k.session_id = t.session_id))
         AS "прочих загрузок _fresh_",
       (SELECT count(*) FROM action_plans t
         WHERE t.session_id ~ '_fresh_[0-9]+$'
           AND NOT EXISTS (SELECT 1 FROM fresh_keys k WHERE k.session_id = t.session_id))
         AS "прочих планов _fresh_",
       (SELECT count(*) FROM chat_context_resets) AS "точек",
       (SELECT count(*) FROM oneoff_20261117_fresh_map) AS "строк в карте отката";

SELECT 'до' AS "этап", * FROM fresh_counts;

-- 1. Точка — парам, где человек на момент выката «в режиме»: его последний ход
--    у этого ассистента был в листе, строго позже последнего хода в основной
--    ленте, и не раньше окна merge_window. Ход — сообщение человека: ответы
--    без вопроса (рутины, сообщения админа, итоги звонков) пишутся в основную
--    ленту и тогда, когда человек в листе, — по ним «вышел ли он из листа» не
--    судим. Давний лист — только перенос ленты (шаги 2–4), без точки.
--    Точка = метка листа этого хода, ровно в мс: целое число мс на интервал
--    1 мс точно (метка < 2^53), без дробных секунд to_timestamp. Но не позже
--    чем за 1 мс до первой строки этого листа: метку ставили часы клиента, и
--    если они спешили, начало листа оказалось бы до точки (фильтр afterReset
--    сравнивает в мс и строго «после», отсюда усечение до мс и минус 1 мс).
--    Удалённому аккаунту точку не ставим — как ChatContextResetService.reset:
--    строка осталась бы сиротой.
CREATE TEMP TABLE in_mode ON COMMIT DROP AS
WITH fresh_turn AS (
  SELECT DISTINCT ON (k.base)
         k.base, k.session_id, k.user_id, k.assistant_id, k.ts, h.created_at AS at
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
)
SELECT f.user_id, f.assistant_id,
       f.at >= (SELECT fresh_since FROM merge_window) AS recent,
       EXISTS (SELECT 1 FROM user_id u
                WHERE u.internal_id = f.user_id AND u.state = 'deleted') AS deleted,
       -- LEAST пропускает NULL: без CASE лист с неверной меткой получил бы точку.
       CASE WHEN f.ts IS NOT NULL THEN
         LEAST(timestamptz 'epoch' + f.ts * interval '1 millisecond',
               (SELECT date_trunc('milliseconds', min(h.created_at)) - interval '1 millisecond'
                  FROM custom_chat_history h
                 WHERE h.session_id = f.session_id))
       END AS reset_at
  FROM fresh_turn f
  LEFT JOIN main_turn m USING (base)
 WHERE m.at IS NULL OR f.at > m.at;
ANALYZE in_mode;

-- Аудит и точки — одним выражением, по одному снимку chat_context_resets
-- (изменяющие CTE выполняются всегда, даже без ссылки на них).
-- В аудит — только пары, где точка действительно поставлена или сдвинута;
-- GREATEST сохраняет точку новее (например, поставленную после выката старой
-- вкладкой). Если её сдвинут между снимком и записью, new_reset_at в аудите не
-- совпадёт с текущей, и откат её не тронет. Обратная гонка: живая точка меньше
-- new_reset_at, зафиксированная в те же миллисекунды (после снимка, до записи),
-- — GREATEST её перекроет, а откат вернёт значение до неё или удалит точку.
-- Редкость, принимаем.
WITH targets AS (
  SELECT user_id, assistant_id, reset_at
    FROM in_mode
   WHERE recent AND reset_at IS NOT NULL AND NOT deleted
), audited AS (
  INSERT INTO oneoff_20261117_resets_audit (user_id, assistant_id, old_reset_at, new_reset_at)
  SELECT t.user_id, t.assistant_id, r.reset_at, t.reset_at
    FROM targets t
    LEFT JOIN chat_context_resets r USING (user_id, assistant_id)
   WHERE r.reset_at IS NULL OR r.reset_at < t.reset_at
  ON CONFLICT (user_id, assistant_id) DO NOTHING
  RETURNING 1
), placed AS (
  INSERT INTO chat_context_resets (user_id, assistant_id, reset_at)
  SELECT user_id, assistant_id, reset_at FROM targets
  ON CONFLICT (user_id, assistant_id) DO UPDATE
    SET reset_at = GREATEST(chat_context_resets.reset_at, EXCLUDED.reset_at)
  RETURNING 1
)
SELECT (SELECT count(*) FROM audited) AS "точек поставлено или сдвинуто",
       (SELECT count(*) FROM in_mode WHERE NOT recent) AS "давних листов без точки",
       (SELECT count(*) FROM in_mode WHERE recent AND reset_at IS NULL)
         AS "свежих листов с неверной меткой",
       (SELECT count(*) FROM in_mode WHERE recent AND reset_at IS NOT NULL AND deleted)
         AS "удалённых аккаунтов без точки";

-- 2. Сообщения листов — в основные ленты; каждая — в карту отката.
WITH moved AS (
  UPDATE custom_chat_history h
     SET session_id = k.base
    FROM fresh_keys k
   WHERE h.session_id = k.session_id
  RETURNING h.id, k.session_id AS fresh_session, k.base
)
INSERT INTO oneoff_20261117_fresh_map (kind, row_id, fresh_suffix)
SELECT 'h', id::text, substr(fresh_session, length(base) + 1) FROM moved
ON CONFLICT (kind, row_id) DO NOTHING;

-- 3. Загрузки — туда же: панель «Медиа и файлы» читает их по ключу ленты, а
--    удаление файла ищет строку 📎 в истории по тому же ключу.
WITH moved AS (
  UPDATE chat_uploads u
     SET session_id = k.base
    FROM fresh_keys k
   WHERE u.session_id = k.session_id
  RETURNING u.id, k.session_id AS fresh_session, k.base
)
INSERT INTO oneoff_20261117_fresh_map (kind, row_id, fresh_suffix)
SELECT 'u', id::text, substr(fresh_session, length(base) + 1) FROM moved
ON CONFLICT (kind, row_id) DO NOTHING;

-- 4. Планы: уникальность (user_id, session_id), а NOT EXISTS видит снимок до
--    UPDATE — два листа одной пары без основного плана получили бы один ключ и
--    уронили бы весь скрипт. Переносим только самый свежий план листов пары и
--    только если у пары нет основного; остальные остаются в своих листах (их
--    никто не читает, данные целы).
WITH cand AS (
  SELECT p.id, k.session_id AS fresh_session, k.base,
         row_number() OVER (PARTITION BY p.user_id, k.base
                            ORDER BY p.updated_at DESC, p.id DESC) AS rn
    FROM action_plans p
    JOIN fresh_keys k ON k.session_id = p.session_id
), moved AS (
  UPDATE action_plans p
     SET session_id = c.base
    FROM cand c
   WHERE p.id = c.id
     AND c.rn = 1
     AND NOT EXISTS (SELECT 1 FROM action_plans q
                      WHERE q.user_id = p.user_id AND q.session_id = c.base)
  RETURNING p.id, c.fresh_session, c.base
)
INSERT INTO oneoff_20261117_fresh_map (kind, row_id, fresh_suffix)
SELECT 'p', id::text, substr(fresh_session, length(base) + 1) FROM moved
ON CONFLICT (kind, row_id) DO NOTHING;

SELECT 'после' AS "этап", * FROM fresh_counts;

DROP VIEW fresh_counts;

COMMIT;
