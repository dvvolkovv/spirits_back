import { BadRequestException, Injectable } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { LanguageService } from '../common/services/language.service';
import { normalizeAgentVersionFields } from './agent-version-validation';
import { AgentVersionsService } from './agent-versions.service';

@Injectable()
export class AgentsService {
  constructor(
    private readonly pg: PgService,
    private readonly versions: AgentVersionsService,
  ) {}

  async getAgentDetails(): Promise<any[]> {
    const res = await this.pg.query(
      'SELECT id, name, system_prompt, description FROM agents ORDER BY id',
    );
    return res.rows;
  }

  /**
   * Служебные строки таблицы agents, которые НЕ являются ассистентами для выбора
   * пользователем. Существуют только как носители system_prompt для отдельных
   * фич и адресуются по id из своего кода, а не через экран выбора.
   *
   * `getAgents` отдаёт таблицу целиком, поэтому без этого фильтра любая такая
   * строка автоматически превращается в карточку на экране выбора ассистента и
   * в строку в настройках голосов.
   *
   * Публичное: тот же фильтр нужен блоку коллег в системном промпте
   * (chat/coworkers.ts) — представлять пользователю можно только тех, кого он
   * может выбрать.
   */
  static readonly SERVICE_AGENTS = ['linkeon_voice'];

  /**
   * Локаль приходит query-параметром, а не из профиля: эндпоинт /webhook/agents
   * публичный (без JwtGuard), userId там недоступен.
   * Незаполненный перевод деградирует в русские колонки, а не в пустоту.
   */
  async getAgents(locale?: string): Promise<any[]> {
    const lang = LanguageService.normalize(locale);
    const res = await this.pg.query(
      `SELECT a.id,
              a.name,
              COALESCE(t.display_name, a.display_name, a.name) AS "displayName",
              COALESCE(t.description, a.description)           AS description,
              a.category
         FROM agents a
         LEFT JOIN agent_translations t
                ON t.entity_type = 'agent'
               AND t.entity_id   = a.id::text
               AND t.locale      = $1
        WHERE a.name <> ALL($2::text[])
          AND a.is_active
        ORDER BY a.id`,
      [lang, AgentsService.SERVICE_AGENTS],
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

  async upsertAgent(data: any, actor: string) {
    if (!data || typeof data !== 'object') {
      throw new BadRequestException('Agent payload must be an object');
    }
    const agentId = data['agent-id'] || data.id;
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    const { description, systemPrompt } = normalizeAgentVersionFields(
      data.description,
      data.system_prompt,
    );

    let existing = agentId ? await this.getAgentById(agentId) : null;
    if (existing) {
      return this.publishExistingAgent(existing, actor, systemPrompt, description);
    }
    if (!name) throw new BadRequestException('name must not be empty');
    existing = await this.getAgentByName(name);
    if (existing) {
      return this.publishExistingAgent(existing, actor, systemPrompt, description);
    }

    const client = await this.pg.getClient();
    let committed = false;
    let destroyClient = false;
    let created = false;
    let agent: any = null;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `legacy-agent-upsert:${name}`,
      ]);
      const current = await client.query(
        'SELECT * FROM agents WHERE name = $1 LIMIT 1',
        [name],
      );
      agent = current.rows[0] || null;
      if (!agent) {
        const res = await client.query(
          `INSERT INTO agents (id, name, system_prompt, description)
           VALUES (COALESCE($4, nextval('agents_id_seq')), $1, $2, $3)
           RETURNING *`,
          [name, systemPrompt, description, agentId],
        );
        agent = res.rows[0];
        await client.query(
          `SELECT setval(
             'agents_id_seq',
             GREATEST(
               (SELECT COALESCE(MAX(id), 0) FROM agents),
               (SELECT last_value FROM agents_id_seq)
             ),
             true
           )`,
        );
        await client.query(
          `INSERT INTO agent_versions
             (agent_id, version, description, system_prompt, status, created_by, published_at, published_by)
           VALUES ($1, 1, $2, $3, 'published', $4, now(), $4)`,
          [agent.id, description, systemPrompt, actor],
        );
        created = true;
      }
      await client.query('COMMIT');
      committed = true;
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

    if (created) return agent;
    return this.publishExistingAgent(agent, actor, systemPrompt, description);
  }

  private async publishExistingAgent(
    existing: any,
    actor: string,
    systemPrompt: string,
    description: string,
  ) {
    const state = await this.versions.getState(existing.id);
    const base = state.draft || state.published;
    if (!base) throw new Error('Agent has no versions');
    const draft = await this.versions.createDraft(actor, existing.id, {
      description,
      system_prompt: systemPrompt,
      base_version_id: base.id,
    });
    await this.versions.publish(
      actor,
      existing.id,
      draft.id,
      state.published?.id ?? null,
    );
    return this.getAgentById(existing.id);
  }
}
