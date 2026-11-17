-- 002: загрузки пользователя — источник, миниатюра, комментарий ассистента
-- (спека docs/superpowers/specs/2026-11-16-chat-uploads-media-notes-design.md).
--
-- Файл выполняется при КАЖДОМ старте API (ChatUploadsService.migrate, сразу
-- после 001), поэтому обязан быть не только идемпотентным, но и дешёвым по
-- замкам. ALTER TABLE … ADD COLUMN IF NOT EXISTS берёт ACCESS EXCLUSIVE ещё ДО
-- проверки, есть ли колонка: на повторном старте он ждал бы каждую открытую
-- запись в chat_uploads, а новые записи вставали бы за ним в очередь. Поэтому
-- каждое ALTER спрятано за проверкой каталога (pg_attribute / pg_constraint):
-- на уже применённой схеме файл не берёт ни одного замка на таблицу.
-- Все новые поля nullable или с default — строки из 001 остаются валидными.
DO $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('chat-uploads/002'));
  PERFORM set_config('lock_timeout', '5s', true);

  -- Откуда пришёл файл: web (веб и оба приложения), scan (PDF Маши), telegram.
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'chat_uploads'::regclass AND attname = 'source' AND NOT attisdropped
  ) THEN
    ALTER TABLE chat_uploads ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'web';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'chat_uploads'::regclass AND conname = 'chat_uploads_source_check'
  ) THEN
    ALTER TABLE chat_uploads
      ADD CONSTRAINT chat_uploads_source_check CHECK (source IN ('web', 'scan', 'telegram'));
  END IF;

  -- Ключ webp-миниатюры в том же приватном бакете: thumbs/<storage_key>.webp.
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'chat_uploads'::regclass AND attname = 'thumb_key' AND NOT attisdropped
  ) THEN
    ALTER TABLE chat_uploads ADD COLUMN IF NOT EXISTS thumb_key text NULL;
  END IF;

  -- Комментарий ассистента к файлу (инструмент note_file), до 500 символов.
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'chat_uploads'::regclass AND attname = 'note' AND NOT attisdropped
  ) THEN
    ALTER TABLE chat_uploads ADD COLUMN IF NOT EXISTS note text NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'chat_uploads'::regclass AND conname = 'chat_uploads_note_len_check'
  ) THEN
    ALTER TABLE chat_uploads
      ADD CONSTRAINT chat_uploads_note_len_check CHECK (note IS NULL OR char_length(note) <= 500);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'chat_uploads'::regclass AND attname = 'note_updated_at' AND NOT attisdropped
  ) THEN
    ALTER TABLE chat_uploads ADD COLUMN IF NOT EXISTS note_updated_at timestamptz NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'chat_uploads'::regclass AND attname = 'note_assistant_id' AND NOT attisdropped
  ) THEN
    ALTER TABLE chat_uploads ADD COLUMN IF NOT EXISTS note_assistant_id text NULL;
  END IF;
END $$;
