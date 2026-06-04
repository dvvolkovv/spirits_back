-- 001_onboarded_flag.sql
-- Флаг прохождения гайд-онбординга (match-экран). Зеркалит isadmin.
-- Бэкфилл: все, у кого уже есть история чата, считаются прошедшими онбординг,
-- чтобы существующие пользователи не увидели экран. session_id в
-- custom_chat_history — это телефон (= user_id), опц. с суффиксом _<agentId>.

ALTER TABLE ai_profiles_consolidated
  ADD COLUMN IF NOT EXISTS onboarded boolean NOT NULL DEFAULT false;

UPDATE ai_profiles_consolidated p
SET onboarded = true
WHERE p.onboarded = false
  AND EXISTS (
    SELECT 1 FROM custom_chat_history c
    WHERE c.session_id = p.user_id
       OR c.session_id LIKE p.user_id || '\_%'
  );
