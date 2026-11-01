import { Injectable } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { LanguageService } from '../common/services/language.service';
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
    const agentId = data['agent-id'] || data.id;
    const { name, system_prompt, description } = data;
    let existing = agentId ? await this.getAgentById(agentId) : null;
    if (!existing) existing = await this.getAgentByName(name);

    if (!existing) {
      const res = await this.pg.query(
        `INSERT INTO agents (id, name, system_prompt, description)
         VALUES (COALESCE($4, nextval('agents_id_seq')), $1, $2, $3)
         RETURNING *`,
        [name, system_prompt, description, agentId],
      );
      const agent = res.rows[0];
      await this.pg.query(
        `INSERT INTO agent_versions
           (agent_id, version, description, system_prompt, status, created_by, published_at, published_by)
         VALUES ($1, 1, $2, $3, 'published', $4, now(), $4)`,
        [agent.id, description, system_prompt, actor],
      );
      return agent;
    }

    const state = await this.versions.getState(existing.id);
    const base = state.draft || state.published;
    if (!base) throw new Error('Agent has no versions');
    const draft = await this.versions.createDraft(actor, existing.id, {
      description,
      system_prompt,
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
