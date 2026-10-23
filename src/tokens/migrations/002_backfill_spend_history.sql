-- Перенос в журнал трат, которые когда-то списывались мимо него, и индекс
-- журнала под сводку расхода по месяцам.
--
-- Спека: docs/superpowers/specs/2026-10-23-spending-summary-design.md.
--
-- ЗАЧЕМ. До августа 2026 картинки, видео и ответы TG-ботов списывали токены
-- прямым UPDATE баланса и строки в token_transactions не оставляли. Сводка
-- расхода читает только журнал, и без переноса у тех, кто тратил весной,
-- картинки и видео выглядели бы «сгоревшими» — ровно жалоба 23.10.2026.
--
-- ЧТО ПЕРЕНОСИТСЯ. Источник → граница (первая строка журнала этой категории
-- на проде, то есть момент, с которого такие списания пишет процедура):
--   generated_images                    → 2026-08-08 09:02:12 UTC, подпись 'image'
--   video_jobs и video_jobs_expired_bak_20260728, только 'ready'
--     (за неудачные тогда возвращали)   → 2026-08-20 02:55:51 UTC, 'Генерация видео'
--   tg_bot_messages, на владельца бота  → 2026-08-11 11:28:37 UTC, 'tg-bot'
-- Подписи — те же, что пишет сегодняшний код: классификатор сводки
-- (src/tokens/spend-category.ts) узнаёт строки без особых правил.
--
-- БАЛАНС НЕ ТРОГАЕМ. Только INSERT в журнал, без процедур и без UPDATE
-- баланса: эти токены уже списаны тогда. balance_after = 0 и пометка
-- reconstructed — как у перенесённых покупок (payments/migrations/002);
-- ручка истории по ней отдаёт остаток null.
--
-- ИДЕМПОТЕНТНОСТЬ. Файл выполняется при КАЖДОМ старте API
-- (TokensSchemaService). У строки metadata.source + metadata.source_id; что
-- уже перенесено, второй раз не вставляется. Весь файл — одна НЕЯВНАЯ
-- транзакция (несколько операторов в одном запросе без BEGIN/COMMIT): при
-- ошибке откатывается целиком и не оставляет соединение пула в прерванной
-- транзакции, как оставил бы явный BEGIN. Два одновременных старта
-- сериализует advisory-лок.
--
-- ЗАЩИТА ОТ ДУБЛЕЙ. Если в журнале уже есть списание того же человека на ту
-- же сумму в пределах двух минут (и это не перенесённая строка), исходную
-- запись пропускаем: ошибка здесь даёт недосчёт, а не двойной счёт.
--
-- ОТСУТСТВУЮЩИЕ ТАБЛИЦЫ. Каждый источник — под to_regclass: резервная таблица
-- видео есть только на проде. PL/pgSQL разрешает имена таблиц при первом
-- исполнении оператора, поэтому ветка под ложным IF может ссылаться на
-- несуществующую таблицу.
--
-- ОТКАТ. Убрать файл из TokensSchemaService.onModuleInit (иначе следующий
-- старт перенесёт заново), затем:
--   DELETE FROM token_transactions
--    WHERE metadata->>'reconstructed' = 'true'
--      AND metadata->>'source' IN ('generated_images', 'video_jobs',
--          'video_jobs_expired_bak_20260728', 'tg_bot_messages');
-- Балансы при этом не меняются.

CREATE INDEX IF NOT EXISTS idx_token_transactions_user_created
    ON token_transactions (user_id, created_at);

DO $backfill$
DECLARE
    c_images CONSTANT timestamptz := '2026-08-08 09:02:12+00';
    c_video  CONSTANT timestamptz := '2026-08-20 02:55:51+00';
    c_tg     CONSTANT timestamptz := '2026-08-11 11:28:37+00';
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('tokens/002_backfill_spend_history'));

    IF to_regclass('public.generated_images') IS NOT NULL THEN
        INSERT INTO token_transactions (user_id, transaction_type, amount, balance_after, description, metadata, created_at)
        SELECT g.user_id, 'consumed'::transaction_type_enum, -g.tokens_spent, 0, 'image',
               jsonb_build_object('reconstructed', true, 'source', 'generated_images', 'source_id', g.id::text),
               g.created_at
          FROM generated_images g
         WHERE g.tokens_spent > 0
           AND g.created_at < c_images
           AND NOT EXISTS (SELECT 1 FROM token_transactions t
                            WHERE t.metadata ->> 'source' = 'generated_images'
                              AND t.metadata ->> 'source_id' = g.id::text)
           AND NOT EXISTS (SELECT 1 FROM token_transactions t
                            WHERE t.user_id = g.user_id
                              AND t.transaction_type = 'consumed'
                              AND t.amount = -g.tokens_spent
                              AND t.created_at BETWEEN g.created_at - interval '2 minutes'
                                                   AND g.created_at + interval '2 minutes'
                              AND (t.metadata ->> 'reconstructed') IS DISTINCT FROM 'true');
    END IF;

    IF to_regclass('public.video_jobs') IS NOT NULL THEN
        INSERT INTO token_transactions (user_id, transaction_type, amount, balance_after, description, metadata, created_at)
        SELECT v.user_id, 'consumed'::transaction_type_enum, -v.tokens_spent, 0, 'Генерация видео',
               jsonb_build_object('reconstructed', true, 'source', 'video_jobs', 'source_id', v.id::text,
                                  'mode', v.mode, 'model', v.model),
               v.created_at
          FROM video_jobs v
         WHERE v.status = 'ready'
           AND v.tokens_spent > 0
           AND v.created_at < c_video
           AND NOT EXISTS (SELECT 1 FROM token_transactions t
                            WHERE t.metadata ->> 'source' = 'video_jobs'
                              AND t.metadata ->> 'source_id' = v.id::text)
           AND NOT EXISTS (SELECT 1 FROM token_transactions t
                            WHERE t.user_id = v.user_id
                              AND t.transaction_type = 'consumed'
                              AND t.amount = -v.tokens_spent
                              AND t.created_at BETWEEN v.created_at - interval '2 minutes'
                                                   AND v.created_at + interval '2 minutes'
                              AND (t.metadata ->> 'reconstructed') IS DISTINCT FROM 'true');
    END IF;

    IF to_regclass('public.video_jobs_expired_bak_20260728') IS NOT NULL THEN
        INSERT INTO token_transactions (user_id, transaction_type, amount, balance_after, description, metadata, created_at)
        SELECT v.user_id, 'consumed'::transaction_type_enum, -v.tokens_spent, 0, 'Генерация видео',
               jsonb_build_object('reconstructed', true, 'source', 'video_jobs_expired_bak_20260728', 'source_id', v.id::text,
                                  'mode', v.mode, 'model', v.model),
               v.created_at
          FROM video_jobs_expired_bak_20260728 v
         WHERE v.status = 'ready'
           AND v.tokens_spent > 0
           AND v.created_at < c_video
           AND NOT EXISTS (SELECT 1 FROM token_transactions t
                            WHERE t.metadata ->> 'source' = 'video_jobs_expired_bak_20260728'
                              AND t.metadata ->> 'source_id' = v.id::text)
           AND NOT EXISTS (SELECT 1 FROM token_transactions t
                            WHERE t.user_id = v.user_id
                              AND t.transaction_type = 'consumed'
                              AND t.amount = -v.tokens_spent
                              AND t.created_at BETWEEN v.created_at - interval '2 minutes'
                                                   AND v.created_at + interval '2 minutes'
                              AND (t.metadata ->> 'reconstructed') IS DISTINCT FROM 'true');
    END IF;

    IF to_regclass('public.tg_bot_messages') IS NOT NULL AND to_regclass('public.tg_bot_configs') IS NOT NULL THEN
        INSERT INTO token_transactions (user_id, transaction_type, amount, balance_after, description, metadata, created_at)
        SELECT c.owner_user_id, 'consumed'::transaction_type_enum, -m.tokens_charged, 0, 'tg-bot',
               jsonb_build_object('reconstructed', true, 'source', 'tg_bot_messages', 'source_id', m.id::text,
                                  'config_id', m.config_id::text),
               m.created_at
          FROM tg_bot_messages m
          JOIN tg_bot_configs c ON c.id = m.config_id
         WHERE m.tokens_charged > 0
           AND m.created_at < c_tg
           AND NOT EXISTS (SELECT 1 FROM token_transactions t
                            WHERE t.metadata ->> 'source' = 'tg_bot_messages'
                              AND t.metadata ->> 'source_id' = m.id::text)
           AND NOT EXISTS (SELECT 1 FROM token_transactions t
                            WHERE t.user_id = c.owner_user_id
                              AND t.transaction_type = 'consumed'
                              AND t.amount = -m.tokens_charged
                              AND t.created_at BETWEEN m.created_at - interval '2 minutes'
                                                   AND m.created_at + interval '2 minutes'
                              AND (t.metadata ->> 'reconstructed') IS DISTINCT FROM 'true');
    END IF;
END
$backfill$;
