CREATE TABLE IF NOT EXISTS agent_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id integer NOT NULL REFERENCES agents(id),
  version integer NOT NULL,
  description text NOT NULL DEFAULT '',
  system_prompt text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('draft', 'published', 'superseded')),
  base_version_id uuid REFERENCES agent_versions(id),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  published_by text,
  UNIQUE (agent_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_versions_one_published
  ON agent_versions(agent_id) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS agent_versions_recent
  ON agent_versions(agent_id, version DESC);
INSERT INTO agent_versions
  (agent_id, version, description, system_prompt, status, created_by, published_at, published_by)
SELECT id, 1, COALESCE(description, ''), COALESCE(system_prompt, ''), 'published', 'migration-008', now(), 'migration-008'
FROM agents
WHERE NOT EXISTS (SELECT 1 FROM agent_versions WHERE agent_id = agents.id);
