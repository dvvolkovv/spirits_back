-- 006_agent_display_name.sql
-- Adds display_name to agents so smm_producer (and any other system agent
-- with a technical name) can be shown to users with a human-friendly name.
-- The `name` column stays as the routing identifier (chat.service.ts:96
-- still matches on 'smm_producer'); UI reads display_name with a fallback.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS display_name text;

-- Backfill: for human-named agents display_name equals name.
UPDATE agents SET display_name = name WHERE display_name IS NULL;

-- The only technical-named agent right now.
UPDATE agents
   SET display_name = 'Юлия',
       description = 'SMM-продюсер: придумываю сценарии для коротких роликов с другими ассистентами Linkeon, рендерю их и публикую в соцсети.'
 WHERE name = 'smm_producer';
