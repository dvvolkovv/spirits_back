-- 002_smm_pricing_seed.sql
INSERT INTO smm_pricing (id, tokens_cost, display_name, description, active) VALUES
  ('economy', 15000, 'Эконом',
   'Yandex SpeechKit голоса. 60-сек вертикальный ролик с фоновой музыкой, B-roll и субтитрами.', true),
  ('premium', 50000, 'Премиум',
   'ElevenLabs Turbo v2.5 с продвинутыми голосами. Лучшее качество озвучки.', true)
ON CONFLICT (id) DO UPDATE
  SET tokens_cost = EXCLUDED.tokens_cost,
      display_name = EXCLUDED.display_name,
      description = EXCLUDED.description,
      active = EXCLUDED.active,
      updated_at = now();
