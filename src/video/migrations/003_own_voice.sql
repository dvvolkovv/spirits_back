-- «Видео голосом оригинала» (96cba3f7): флаг, что финальную дорожку Veo надо
-- заменить на голос пользователя (clone + speech-to-speech) перед status=ready.
ALTER TABLE video_jobs
  ADD COLUMN IF NOT EXISTS own_voice boolean DEFAULT false;
