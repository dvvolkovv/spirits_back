import {
  BadRequestException,
  ConflictException,
  Injectable,
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
    await this.pg.query(fs.readFileSync(migrationPath, 'utf8'));
  }

  async latest(agentId: number): Promise<AgentVersion | null> {
    const result = await this.pg.query(
      `SELECT * FROM agent_versions
       WHERE agent_id = $1
       ORDER BY version DESC
       LIMIT 1`,
      [agentId],
    );
    return result.rows[0] || null;
  }

  async createDraft(
    actor: string,
    agentId: number,
    data: {
      description: string;
      system_prompt: string;
      base_version_id: string;
    },
  ): Promise<AgentVersion> {
    const description = data.description.trim();
    const systemPrompt = data.system_prompt.trim();
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
      return result.rows[0];
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
