-- Обобщение рутин (Слой 3+): несколько рутин на юзера, имя, дни недели.
-- Идентичность рутины теперь по id (uuid), а не по (user_id, kind).

ALTER TABLE routine_pushes ADD COLUMN IF NOT EXISTS title text;
-- Дни недели отправки (локальные, 0=Вс .. 6=Сб). NULL/пусто = каждый день.
ALTER TABLE routine_pushes ADD COLUMN IF NOT EXISTS days smallint[];

-- Снимаем уникальность (user_id, kind) — теперь допускается много рутин на юзера.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'routine_pushes'::regclass AND contype = 'u' LOOP
    EXECUTE 'ALTER TABLE routine_pushes DROP CONSTRAINT ' || quote_ident(c.conname);
  END LOOP;
END $$;

-- Бэкфилл имени для существующих рутин.
UPDATE routine_pushes
   SET title = CASE WHEN assistant_id = '14' THEN 'Энергия дня' ELSE 'Напоминание' END
 WHERE title IS NULL;
