-- 001_shorts.sql — таблицы коротких роликов.
--
-- Спека: docs/superpowers/specs/2026-10-24-promo-shorts-design.md, «Данные».
-- План: docs/superpowers/plans/2026-10-25-promo-shorts-2-pipeline.md, задача 2.
--
-- КАК КАТИТСЯ. ShortsSchemaService выполняет файл при КАЖДОМ старте API: общий
-- migrate-раннер на проде сломан (см. tokens-schema.service.ts). Поэтому файл
-- идемпотентен, и весь он — один оператор DO, то есть одна транзакция.
--
-- ЗАМКИ. Первым — advisory-лок: два одновременных старта (cluster_mode) идут
-- по очереди. Дальше чужих замков ждём не дольше 5 с (lock_timeout только в
-- этой транзакции): ошибка откатит файл, следующий старт повторит. Таблицы и
-- индексы создаются только под IF to_regclass(...) IS NULL. Голый CREATE INDEX
-- IF NOT EXISTS берёт ShareLock даже на готовый индекс и на каждом старте ждал
-- бы открытые записи (так было в tokens/002, проверено на PG 16).
--
-- Строка настроек вставляется под IF NOT EXISTS (SELECT …): обычный SELECT не
-- ждёт чужую незакрытую правку настроек, а INSERT … ON CONFLICT мог бы.
--
-- ОТКАТ (ролики пропадут): убрать ShortsSchemaService из shorts.module.ts —
-- иначе следующий старт создаст таблицы заново, — затем
--   DROP TABLE short_publication; DROP TABLE short_video; DROP TABLE short_settings;

DO $shorts$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('shorts/001'));
    PERFORM set_config('lock_timeout', '5s', true);

    IF to_regclass('public.short_video') IS NULL THEN
        CREATE TABLE short_video (
            id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            rubric            text NOT NULL CHECK (rubric IN ('assistant', 'feature', 'news', 'case')),
            -- Подача. angle_locked — задана при заказе; иначе её ставит ритм недели при запуске.
            angle             text NOT NULL DEFAULT 'calm'
                                CHECK (angle IN ('uncomfortable', 'roast', 'myth', 'calm')),
            angle_locked      boolean NOT NULL DEFAULT false,
            source            text NOT NULL CHECK (source IN ('catalog', 'git', 'manual')),
            source_ref        text,
            topic_key         text NOT NULL,
            topic_hint        text,
            title             text,
            assistant_id      int,
            -- Для меток: только [a-z0-9_], до 40 символов (vk-ads разбирает [A-Za-z0-9_]+).
            slug              text CHECK (slug IS NULL OR slug ~ '^[a-z0-9_]{1,40}$'),
            lang              text NOT NULL DEFAULT 'ru',
            scene             jsonb,
            capture           jsonb,
            script            jsonb,
            captions          jsonb,
            video_key         text,
            cover_key         text,
            duration_ms       int,
            status            text NOT NULL DEFAULT 'idea' CHECK (status IN (
                                'idea', 'directing', 'capture_queued', 'capturing', 'writing',
                                'render_queued', 'rendering', 'pending_review', 'approved',
                                'publishing', 'published', 'rejected', 'failed')),
            -- До одобрения — планируемый слот, после — занятый.
            slot_at           timestamptz,
            -- Ролик одобрял человек: только такой можно вернуть в approved повтором публикации.
            approved_at       timestamptz,
            owner_note        text,
            -- Пояснение сценаристу от студии: озвучка вышла за 30–60 с.
            writer_feedback   text,
            writer_rounds     int NOT NULL DEFAULT 0,
            review_chat_id    bigint,
            review_message_id bigint,
            note_prompt_ids   bigint[] NOT NULL DEFAULT '{}'::bigint[],
            yt_prompt_ids     bigint[] NOT NULL DEFAULT '{}'::bigint[],
            -- Аренда этапа: API (режиссёр, сценарист, отправка владельцу) и студия (съёмка, сборка).
            lease_until       timestamptz,
            attempts          int NOT NULL DEFAULT 0,
            last_error        text,
            failed_from       text,
            failure_notified  boolean NOT NULL DEFAULT false,
            published_at      timestamptz,
            created_at        timestamptz NOT NULL DEFAULT now(),
            updated_at        timestamptz NOT NULL DEFAULT now()
        );
    END IF;

    -- Один ролик на слот, как blog/004: слот держат approved и publishing.
    IF to_regclass('public.uq_short_video_slot') IS NULL THEN
        CREATE UNIQUE INDEX uq_short_video_slot ON short_video (slot_at)
            WHERE status IN ('approved', 'publishing');
    END IF;
    -- Повторная доставка /short и повторное наполнение недели второй ролик не заводят.
    IF to_regclass('public.uq_short_video_source_ref') IS NULL THEN
        CREATE UNIQUE INDEX uq_short_video_source_ref ON short_video (source_ref)
            WHERE source_ref IS NOT NULL;
    END IF;
    IF to_regclass('public.idx_short_video_status') IS NULL THEN
        CREATE INDEX idx_short_video_status ON short_video (status, lease_until);
    END IF;

    -- Статус по площадке отдельно: Telegram вышел, YouTube ждёт — повторяем только упавшую.
    IF to_regclass('public.short_publication') IS NULL THEN
        CREATE TABLE short_publication (
            short_id      uuid NOT NULL REFERENCES short_video(id),
            platform      text NOT NULL CHECK (platform IN ('telegram', 'vk', 'youtube')),
            status        text NOT NULL CHECK (status IN (
                            'pending', 'publishing', 'published', 'failed',
                            'manual_pending', 'manual_done')),
            external_id   text,
            url           text,
            views         int,
            views_at      timestamptz,
            attempts      int NOT NULL DEFAULT 0,
            last_error    text,
            published_at  timestamptz,
            created_at    timestamptz NOT NULL DEFAULT now(),
            updated_at    timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (short_id, platform)
        );
    END IF;

    IF to_regclass('public.short_settings') IS NULL THEN
        CREATE TABLE short_settings (
            id                  int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
            slot_days           int[] NOT NULL DEFAULT '{2,4,6}',
            slot_hour_msk       int   NOT NULL DEFAULT 18,
            prepare_lead_hours  int   NOT NULL DEFAULT 24,
            min_answer_chars    int   NOT NULL DEFAULT 400,
            tg_channel_chat_id  text,
            vk_group_id         bigint,
            youtube_channel_id  text,
            platforms           text[] NOT NULL DEFAULT '{telegram,youtube}',
            narrator_voice      text  NOT NULL DEFAULT 'alena',
            updated_at          timestamptz NOT NULL DEFAULT now()
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM short_settings WHERE id = 1) THEN
        INSERT INTO short_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
    END IF;
END
$shorts$;
