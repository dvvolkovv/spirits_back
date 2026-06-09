-- 002_tg_bot_custom_agent_fk.sql
-- Связать tg_bot_configs.custom_agent_id с custom_agents.id (без CASCADE — блок удаления).
-- Идемпотентно: DO-блок не упадёт при повторных запусках onModuleInit.
DO $$ BEGIN
  ALTER TABLE tg_bot_configs
    ADD CONSTRAINT fk_tg_bot_configs_custom_agent
      FOREIGN KEY (custom_agent_id) REFERENCES custom_agents(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN
  -- constraint уже есть, скипаем
  NULL;
END $$;
