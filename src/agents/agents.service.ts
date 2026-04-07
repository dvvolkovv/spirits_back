import { Injectable } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';

@Injectable()
export class AgentsService {
  constructor(private readonly pg: PgService) {}

  async getAgentDetails(): Promise<any[]> {
    const res = await this.pg.query(
      'SELECT id, name, system_prompt, description FROM agents ORDER BY id',
    );
    return res.rows;
  }

  async getAgents(): Promise<any[]> {
    const res = await this.pg.query(
      'SELECT id, name, description FROM agents ORDER BY id',
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
    const agentId = data['agent-id'] || data.id;
    const { name, system_prompt, description } = data;

    // If we have an ID, update by ID
    if (agentId) {
      const res = await this.pg.query(
        `UPDATE agents SET system_prompt = $1, description = $2 WHERE id = $3 RETURNING *`,
        [system_prompt, description, agentId],
      );
      if (res.rows.length) return res.rows[0];
    }

    // Otherwise insert/upsert by name
    const res = await this.pg.query(
      `INSERT INTO agents (name, system_prompt, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET
         system_prompt = EXCLUDED.system_prompt,
         description = EXCLUDED.description
       RETURNING *`,
      [name, system_prompt, description],
    );
    return res.rows[0];
  }
}
