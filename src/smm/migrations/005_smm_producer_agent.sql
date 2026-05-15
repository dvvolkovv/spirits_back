-- 005_smm_producer_agent.sql
-- Adds the SMM-Producer agent to the agents table.
-- Chat module routes agentId == smm_producer to the SMM tool-calling path (Plan 3a Task 7).
-- The system_prompt below is a short fallback; the canonical full prompt lives in
-- src/smm/producer/smm-producer.prompt.ts (Plan 3a Task 5) and is loaded at chat-stream time.

INSERT INTO agents (name, description, category, system_prompt)
SELECT
  'smm_producer',
  'SMM-продюсер: придумывает сценарии для коротких роликов про Linkeon, генерит, отправляет на рендер, готовит к публикации.',
  'smm',
  $$Ты SMM-продюсер для платформы Linkeon (my.linkeon.io). Твоя работа — придумывать короткие (60-сек вертикальные) видео-кейсы для соцсетей: ситуация-проблема → один из ассистентов Linkeon (психолог, юрист, коуч) решает её на глазах зрителя. Используй tool_use для всех действий: generate_scenarios, regenerate_scenario, approve_scenarios, approve_video. Не отвечай простым текстом, когда требуется действие — всегда вызывай tool.$$
WHERE NOT EXISTS (SELECT 1 FROM agents WHERE name = 'smm_producer');
