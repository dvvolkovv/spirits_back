-- Хранит клон голоса пользователя (ElevenLabs voice_id) + авто-дескриптор
-- голоса (Gemini), используемый для подбора голоса Veo-рассказчика.
-- Клонируем один раз на юзера; переиспользуем для всех его роликов.
CREATE TABLE IF NOT EXISTS user_voice (
  user_id              text PRIMARY KEY,
  elevenlabs_voice_id  text,
  voice_descriptor     jsonb,
  sample_url           text,
  consent_at           timestamptz,
  status               text NOT NULL DEFAULT 'pending', -- pending|ready|failed
  error_message        text,
  created_at           timestamptz DEFAULT now(),
  updated_at           timestamptz DEFAULT now()
);
