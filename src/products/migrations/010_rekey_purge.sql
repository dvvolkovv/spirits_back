-- 010_rekey_purge.sql
-- Ассистент ведёт продукт целиком, очередь 2: смена ключей (задание rekey) и
-- стирание удалённых (задание purge). Спека:
-- docs/superpowers/specs/2026-10-25-product-full-lifecycle-design.md.
-- Катится на каждом старте вместе со всем списком MIGRATIONS, идемпотентно.
--
-- ОБЯЗАТЕЛЬНАЯ (FATAL_MIGRATIONS в products.service.ts) ПРЕВЕНТИВНО, как 008:
-- с Task 9 плана очереди 2 выдача заданий агенту (claimJob) станет читать
-- product_provision_jobs.action_id в КАЖДОМ опросе, для задания любого вида.
-- Молча не применившаяся 010 означала бы 42703 на каждом опросе агента уже
-- после той задачи: ни одного заведения, сна и пробуждения ни у одного
-- клиента. Запланированных отказов в файле нет: ADD COLUMN IF NOT EXISTS и
-- индекс под проверкой существования.
--
-- Словарь видов задания (rekey, purge) — НЕ здесь, а в 004: он объявлен
-- только там, и 004 едет раньше при каждом старте (см. шапки 004 и 008).
SELECT pg_advisory_xact_lock(hashtext('products/010_rekey_purge'));

-- Какая карточка поставила задание. Нужна смене ключей: новые ключи лежат
-- шифротекстом в product_actions.secrets_box, выдача задания расшифровывает
-- их оттуда, а отчёт агента тем же оператором закрывает карточку. SET NULL, а
-- не CASCADE: задание — история машины продукта, оно переживает журнал.
ALTER TABLE product_provision_jobs
  ADD COLUMN IF NOT EXISTS action_id uuid REFERENCES product_actions(id) ON DELETE SET NULL;

-- Индекс — только если его нет: CREATE INDEX IF NOT EXISTS на каждом старте
-- берёт ShareLock на таблицу даже при существующем индексе (заметка памяти
-- «CREATE INDEX в стартовой миграции»).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_provision_jobs_action') THEN
    CREATE INDEX idx_provision_jobs_action ON product_provision_jobs (action_id) WHERE action_id IS NOT NULL;
  END IF;
END $$;
