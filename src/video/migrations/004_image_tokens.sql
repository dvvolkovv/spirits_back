-- Стоимость кадра-заготовки, списанная перед анимацией.
--
-- text2video без картинки идёт цепочкой: Nano Banana рисует кадр, Kling его
-- анимирует. Списание за кадр уходило отдельной транзакцией 'image', а в
-- video_jobs не попадало — при провале Kling возвращать было нечего, и
-- пользователь платил за заготовку от несостоявшегося ролика.
ALTER TABLE video_jobs
  ADD COLUMN IF NOT EXISTS image_tokens_spent bigint NOT NULL DEFAULT 0;
