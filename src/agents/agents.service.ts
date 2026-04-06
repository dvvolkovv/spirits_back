import { Injectable } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';

@Injectable()
export class AgentsService {
  constructor(private readonly pg: PgService) {}

  async getAgentDetails(): Promise<any[]> {
    const res = await this.pg.query(
      'SELECT id, name, system_prompt, avatar_url, description, model FROM agents ORDER BY id',
    );
    return res.rows;
  }

  async getAgents(): Promise<any[]> {
    const res = await this.pg.query(
      'SELECT id, name, avatar_url, description FROM agents ORDER BY id',
    );
    return res.rows;
  }

  async getAgentById(id: string | number): Promise<any | null> {
    const res = await this.pg.query(
      'SELECT * FROM agents WHERE id = $1 LIMIT 1',
      [id],
    );
    return res.rows[0] || null;
  }

  async getAgentByName(name: string): Promise<any | null> {
    const res = await this.pg.query(
      'SELECT * FROM agents WHERE name = $1 LIMIT 1',
      [name],
    );
    return res.rows[0] || null;
  }

  async changeAgent(userId: string, agentName: string) {
    await this.pg.query(
      'UPDATE ai_profiles_consolidated SET preferred_agent = $1, updated_at = now() WHERE user_id = $2',
      [agentName, userId],
    );
    return { success: true };
  }

  async upsertAgent(data: any) {
    const { name, system_prompt, avatar_url, description, model } = data;
    const res = await this.pg.query(
      `INSERT INTO agents (name, system_prompt, avatar_url, description, model)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (name) DO UPDATE SET
         system_prompt = EXCLUDED.system_prompt,
         avatar_url = EXCLUDED.avatar_url,
         description = EXCLUDED.description,
         model = EXCLUDED.model
       RETURNING *`,
      [name, system_prompt, avatar_url, description, model],
    );
    return res.rows[0];
  }
}
