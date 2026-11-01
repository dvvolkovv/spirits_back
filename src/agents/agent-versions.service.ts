import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { ChatService } from '../chat/chat.service';
import { PgService } from '../common/services/pg.service';

export type AgentVersionStatus = 'draft' | 'published' | 'superseded';

export interface AgentVersion {
  id: string;
  agent_id: number;
  version: number;
  description: string;
  system_prompt: string;
  status: AgentVersionStatus;
  base_version_id: string | null;
  created_by: string;
  created_at: string;
  published_at: string | null;
  published_by: string | null;
}

function toAgentVersion(row: any): AgentVersion {
  const iso = (value: Date | string) =>
    (value instanceof Date ? value : new Date(value)).toISOString();
  return {
    id: row.id,
    agent_id: row.agent_id,
    version: row.version,
    description: row.description,
    system_prompt: row.system_prompt,
    status: row.status,
    base_version_id: row.base_version_id ?? null,
    created_by: row.created_by,
    created_at: iso(row.created_at),
    published_at: row.published_at == null ? null : iso(row.published_at),
    published_by: row.published_by ?? null,
  };
}

@Injectable()
export class AgentVersionsService implements OnModuleInit {
  constructor(
    private readonly pg: PgService,
    private readonly chat: ChatService,
  ) {}

  async onModuleInit(): Promise<void> {
    const candidates = [
      path.join(__dirname, 'migrations', '008_agent_versions.sql'),
      path.join(
        __dirname,
        '..',
        '..',
        'src',
        'agents',
        'migrations',
        '008_agent_versions.sql',
      ),
    ];
    const migrationPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!migrationPath) {
      throw new Error(
        `Agent versions migration 008_agent_versions.sql not found; tried: ${candidates.join(', ')}`,
      );
    }
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    const client = await this.pg.getClient();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('agent_versions_008'))",
      );
      await client.query(migrationSql);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async latest(agentId: number): Promise<AgentVersion | null> {
    const result = await this.pg.query(
      `SELECT * FROM agent_versions
       WHERE agent_id = $1
       ORDER BY version DESC
       LIMIT 1`,
      [agentId],
    );
    return result.rows[0] ? toAgentVersion(result.rows[0]) : null;
  }

  async getVersion(agentId: number, versionId: string): Promise<AgentVersion> {
    const result = await this.pg.query(
      `SELECT * FROM agent_versions
       WHERE id = $1 AND agent_id = $2`,
      [versionId, agentId],
    );
    if (!result.rows[0]) {
      throw new NotFoundException('Agent version not found');
    }
    return toAgentVersion(result.rows[0]);
  }

  async listVersions(agentId: number, limit = 50): Promise<AgentVersion[]> {
    const boundedLimit = Number.isFinite(limit)
      ? Math.min(50, Math.max(1, Math.trunc(limit)))
      : 50;
    const result = await this.pg.query(
      `SELECT * FROM agent_versions
       WHERE agent_id = $1
       ORDER BY version DESC
       LIMIT $2`,
      [agentId, boundedLimit],
    );
    return result.rows.map(toAgentVersion);
  }

  async getState(agentId: number): Promise<{
    published: AgentVersion | null;
    draft: AgentVersion | null;
  }> {
    const result = await this.pg.query(
      `SELECT
         (SELECT row_to_json(published)
          FROM (
            SELECT * FROM agent_versions
            WHERE agent_id = $1 AND status = 'published'
          ) published) AS published,
         (SELECT row_to_json(draft)
          FROM (
            SELECT * FROM agent_versions
            WHERE agent_id = $1 AND status = 'draft'
            ORDER BY version DESC
            LIMIT 1
          ) draft) AS draft`,
      [agentId],
    );
    const state = result.rows[0];
    return {
      published: state.published ? toAgentVersion(state.published) : null,
      draft: state.draft ? toAgentVersion(state.draft) : null,
    };
  }

  async publish(
    actor: string,
    agentId: number,
    versionId: string,
    expectedPublishedId: string | null,
  ): Promise<AgentVersion> {
    const draft = await this.getVersion(agentId, versionId);
    if (draft.status !== 'draft') {
      throw new ConflictException('Only draft versions can be published');
    }

    const client = await this.pg.getClient();
    let committed = false;
    let destroyClient = false;
    try {
      await client.query('BEGIN');
      const agentResult = await client.query(
        'SELECT id FROM agents WHERE id = $1 FOR UPDATE',
        [agentId],
      );
      if (!agentResult.rows[0]) {
        throw new NotFoundException('Agent not found');
      }
      const currentResult = await client.query(
        `SELECT * FROM agent_versions
         WHERE agent_id = $1 AND status = 'published'
         FOR UPDATE`,
        [agentId],
      );
      const currentPublished = currentResult.rows[0];
      if ((currentPublished?.id ?? null) !== expectedPublishedId) {
        throw new ConflictException('Published version is stale');
      }

      if (currentPublished) {
        await client.query(
          `UPDATE agent_versions
           SET status = 'superseded'
           WHERE id = $1 AND agent_id = $2`,
          [currentPublished.id, agentId],
        );
      }
      const publishedResult = await client.query(
        `UPDATE agent_versions
         SET status = 'published', published_at = now(), published_by = $1
         WHERE id = $2 AND agent_id = $3
         RETURNING *`,
        [actor, versionId, agentId],
      );
      await client.query(
        `UPDATE agents
         SET description = $1, system_prompt = $2
         WHERE id = $3`,
        [draft.description, draft.system_prompt, agentId],
      );
      await client.query('COMMIT');
      committed = true;
      return toAgentVersion(publishedResult.rows[0]);
    } catch (e) {
      if (!committed) {
        try {
          await client.query('ROLLBACK');
        } catch {
          destroyClient = true;
        }
      }
      throw e;
    } finally {
      if (destroyClient) client.release(true);
      else client.release();
    }
  }

  async createDraft(
    actor: string,
    agentId: number,
    data: {
      description?: unknown;
      system_prompt?: unknown;
      base_version_id: string;
    },
  ): Promise<AgentVersion> {
    const description =
      typeof data.description === 'string' ? data.description.trim() : '';
    const systemPrompt =
      typeof data.system_prompt === 'string' ? data.system_prompt.trim() : '';
    if (!systemPrompt) {
      throw new BadRequestException('system_prompt must not be empty');
    }
    if (systemPrompt.length > 200000) {
      throw new BadRequestException('system_prompt must not exceed 200000 characters');
    }
    if (description.length > 5000) {
      throw new BadRequestException('description must not exceed 5000 characters');
    }

    const base = await this.latest(agentId);
    if (!base || base.id !== data.base_version_id) {
      throw new ConflictException('Base version is stale');
    }

    try {
      const result = await this.pg.query(
        `INSERT INTO agent_versions
           (agent_id, description, system_prompt, status, base_version_id, created_by, version)
         VALUES ($1, $2, $3, 'draft', $4, $5, $6)
         RETURNING *`,
        [
          agentId,
          description,
          systemPrompt,
          data.base_version_id,
          actor,
          base.version + 1,
        ],
      );
      return toAgentVersion(result.rows[0]);
    } catch (e: any) {
      if (
        e?.code === '23505' &&
        e?.constraint === 'agent_versions_agent_id_version_key'
      ) {
        throw new ConflictException('Agent version was created concurrently');
      }
      throw e;
    }
  }
}
