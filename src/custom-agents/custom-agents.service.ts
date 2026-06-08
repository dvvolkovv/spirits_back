import { Injectable, Logger, OnModuleInit, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { PgService } from '../common/services/pg.service';

export interface CustomAgentRow {
  id: string;
  owner_user_id: string;
  name: string;
  description: string | null;
  system_prompt: string;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class CustomAgentsService implements OnModuleInit {
  private readonly logger = new Logger(CustomAgentsService.name);
  private anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  constructor(private readonly pg: PgService) {}

  async onModuleInit() {
    const candidates = [
      path.join(__dirname, 'migrations', '001_custom_agents.sql'),
      path.join(__dirname, '..', '..', 'src', 'custom-agents', 'migrations', '001_custom_agents.sql'),
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          await this.pg.query(fs.readFileSync(p, 'utf8'));
          this.logger.log(`custom_agents migration applied from ${p}`);
          return;
        }
      } catch (e: any) {
        this.logger.error(`custom_agents migration failed (${p}): ${e.message}`);
      }
    }
    this.logger.warn('custom_agents migration sql not found, skipping');
  }

  async list(ownerId: string): Promise<CustomAgentRow[]> {
    const r = await this.pg.query(
      `SELECT id, owner_user_id, name, description, system_prompt, created_at, updated_at
         FROM custom_agents
        WHERE owner_user_id = $1
        ORDER BY updated_at DESC`,
      [ownerId],
    );
    return r.rows;
  }

  async getById(id: string, ownerId: string): Promise<CustomAgentRow> {
    const r = await this.pg.query(
      `SELECT id, owner_user_id, name, description, system_prompt, created_at, updated_at
         FROM custom_agents
        WHERE id = $1 AND owner_user_id = $2
        LIMIT 1`,
      [id, ownerId],
    );
    if (r.rows.length === 0) {
      throw new NotFoundException(`Custom agent ${id} not found or not owned by user`);
    }
    return r.rows[0];
  }

  async create(
    ownerId: string,
    data: { name: string; description?: string; systemPrompt: string },
  ): Promise<CustomAgentRow> {
    const r = await this.pg.query(
      `INSERT INTO custom_agents (owner_user_id, name, description, system_prompt)
       VALUES ($1, $2, $3, $4)
       RETURNING id, owner_user_id, name, description, system_prompt, created_at, updated_at`,
      [ownerId, data.name.trim(), data.description?.trim() || null, data.systemPrompt.trim()],
    );
    return r.rows[0];
  }

  async update(
    id: string,
    ownerId: string,
    data: { name?: string; description?: string; systemPrompt?: string },
  ): Promise<CustomAgentRow> {
    await this.getById(id, ownerId);
    const fields: string[] = [];
    const params: any[] = [];
    let idx = 1;
    if (data.name !== undefined) { fields.push(`name = $${idx++}`); params.push(data.name.trim()); }
    if (data.description !== undefined) {
      fields.push(`description = $${idx++}`);
      params.push(data.description.trim() || null);
    }
    if (data.systemPrompt !== undefined) {
      fields.push(`system_prompt = $${idx++}`);
      params.push(data.systemPrompt.trim());
    }
    if (fields.length === 0) return this.getById(id, ownerId);
    fields.push(`updated_at = now()`);
    params.push(id, ownerId);
    const r = await this.pg.query(
      `UPDATE custom_agents SET ${fields.join(', ')}
        WHERE id = $${idx++} AND owner_user_id = $${idx}
        RETURNING id, owner_user_id, name, description, system_prompt, created_at, updated_at`,
      params,
    );
    return r.rows[0];
  }

  async remove(id: string, ownerId: string): Promise<void> {
    await this.getById(id, ownerId);
    await this.pg.query(
      `DELETE FROM custom_agents WHERE id = $1 AND owner_user_id = $2`,
      [id, ownerId],
    );
  }

  async draftPrompt(description: string): Promise<{ name: string; systemPrompt: string }> {
    const sys = `Ты помогаешь создавать system prompts для AI-ассистентов в Linkeon.
Пользователь дал короткое описание роли. Сгенерируй:
1) Краткое имя (1-3 слова, по-русски, для отображения в селекторе).
2) System prompt на русском в 200-400 слов:
   - кто этот ассистент (характер, экспертиза)
   - как он общается (стиль, тон)
   - на каких темах фокусируется
   - чего избегает

Отвечай строго JSON-объектом вида {"name": "...", "systemPrompt": "..."} без markdown-обёртки.`;

    const resp = await this.anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 2000,
      system: sys,
      messages: [{ role: 'user', content: description.trim() }],
    });

    const textBlock = resp.content.find((b: any) => b.type === 'text') as any;
    if (!textBlock?.text) {
      throw new Error('Empty response from Haiku');
    }

    let parsed: { name: string; systemPrompt: string };
    try {
      parsed = JSON.parse(textBlock.text);
    } catch {
      const cleaned = textBlock.text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
      parsed = JSON.parse(cleaned);
    }

    if (!parsed.name || !parsed.systemPrompt) {
      throw new Error('Malformed draft response');
    }
    return { name: parsed.name.trim(), systemPrompt: parsed.systemPrompt.trim() };
  }
}
