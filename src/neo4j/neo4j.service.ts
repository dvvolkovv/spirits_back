import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import neo4j, { Driver, Session } from 'neo4j-driver';
import axios from 'axios';

@Injectable()
export class Neo4jService implements OnModuleInit, OnModuleDestroy {
  private driver: Driver | null = null;
  private readonly logger = new Logger(Neo4jService.name);

  onModuleInit() {
    const uri = process.env.NEO4J_URI;
    const user = process.env.NEO4J_USER;
    const password = process.env.NEO4J_PASSWORD;
    if (!uri || !user || !password) {
      this.logger.warn('Neo4j credentials not set — graph features disabled');
      return;
    }
    try {
      this.driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
        connectionTimeout: 5000,
        maxConnectionLifetime: 3600000,
      });
      this.logger.log('Neo4j driver initialized');
    } catch (e) {
      this.logger.error(`Neo4j init failed: ${e.message}`);
    }
  }

  async onModuleDestroy() {
    if (this.driver) await this.driver.close();
  }

  private getSession(): Session | null {
    if (!this.driver) return null;
    return this.driver.session();
  }

  async createOrGetProfile(userId: string): Promise<any> {
    const session = this.getSession();
    if (!session) return null;
    try {
      const result = await session.run(
        `MERGE (p:Profile {phone: $phone})
         ON CREATE SET
           p.id = 'profile_' + $phone,
           p.created_at = datetime(),
           p.updated_at = datetime(),
           p.is_empty = true,
           p.profile_status = 'active',
           p.version = 1,
           p.last_active = datetime()
         ON MATCH SET
           p.updated_at = datetime(),
           p.last_active = datetime(),
           p.version = p.version + 1
         RETURN p`,
        { phone: userId },
      );
      return result.records[0]?.get('p')?.properties || null;
    } finally {
      await session.close();
    }
  }

  async getProfileDescription(userId: string): Promise<string> {
    const session = this.getSession();
    if (!session) return '';
    try {
      // Use subqueries to avoid Cartesian product explosion
      const result = await session.run(
        `MATCH (p:Profile {phone: $phone})
         RETURN
           p.phone AS phone,
           COALESCE(p.name, '') AS name,
           COALESCE(p.family_name, '') AS family_name,
           [(p)-[r:HAS_INTEREST]->(n:Interest) | {name: n.name, confidence: r.confidence}] AS interests,
           [(p)-[r:HAS_DESIRE]->(n:Desire) | {name: n.name, confidence: r.confidence}] AS desires,
           [(p)-[r:HAS_BELIEF]->(n:Belief) | {name: n.name, confidence: r.confidence}] AS beliefs,
           [(p)-[r:HAS_INTENT]->(n:Intent) | {name: n.name, confidence: r.confidence}] AS intents,
           [(p)-[r:HAS_VALUE]->(n:Value) | {name: n.name, confidence: r.confidence}] AS values,
           [(p)-[r:HAS_SKILL]->(n:Skill) | {name: n.name, confidence: r.confidence}] AS skills`,
        { phone: userId },
      );

      if (!result.records.length) return '';
      const rec = result.records[0];

      const fmt = (items: any[]) => items
        .filter(x => x.name)
        .slice(0, 20) // limit to top 20 per category
        .map(x => `${x.name}(confidence:${Math.round(Number(x.confidence) || 5)})`)
        .join(', ');

      const name = rec.get('name');
      const familyName = rec.get('family_name');
      const lines = [
        `Profile: ${rec.get('phone')}${name ? ` name: ${name}` : ''}${familyName ? ` family name: ${familyName}` : ''}`,
        `Interests: ${fmt(rec.get('interests'))}`,
        `Desires: ${fmt(rec.get('desires'))}`,
        `Beliefs: ${fmt(rec.get('beliefs'))}`,
        `Intents: ${fmt(rec.get('intents'))}`,
        `Values: ${fmt(rec.get('values'))}`,
        `Skills: ${fmt(rec.get('skills'))}`,
      ];
      return lines.join('\n');
    } catch (e) {
      this.logger.error(`getProfileDescription error: ${e.message}`);
      return '';
    } finally {
      await session.close();
    }
  }

  async updateProfileEntities(userId: string, entityType: string, values: string[]): Promise<void> {
    const session = this.getSession();
    if (!session) return;
    const type = entityType.charAt(0).toUpperCase() + entityType.slice(1).toLowerCase();
    const rel = `HAS_${type.toUpperCase()}`;
    try {
      // Delete old relationships not in new values
      await session.run(
        `MATCH (p:Profile {phone: $phone})-[r:${rel}]->(v:${type})
         WHERE NOT v.name IN $values
         DELETE r`,
        { phone: userId, values },
      );
      // Create new relationships
      for (const valueName of values) {
        if (!valueName?.trim()) continue;
        await session.run(
          `MATCH (p:Profile {phone: $phone})
           MERGE (v:${type} {name: $name})
           MERGE (p)-[r:${rel}]->(v)
           ON CREATE SET r.created_at = datetime(), r.confidence = 5
           ON MATCH SET r.updated_at = datetime()`,
          { phone: userId, name: valueName },
        );
      }
    } catch (e) {
      this.logger.error(`updateProfileEntities error: ${e.message}`);
    } finally {
      await session.close();
    }
  }

  async consolidateFromChat(userId: string, userMessage: string, assistantResponse: string): Promise<void> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey || !this.driver) return;

    try {
      const prompt = `Из следующего диалога извлеки психологический профиль пользователя.
Верни ТОЛЬКО JSON в формате:
{
  "interests": ["..."],
  "values": ["..."],
  "desires": ["..."],
  "beliefs": ["..."],
  "intents": ["..."],
  "skills": ["..."]
}
Если нечего добавить в категорию — пустой массив. Только реальные факты из диалога.

Пользователь: ${userMessage}
Ассистент: ${assistantResponse}`;

      const resp = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: process.env.CONSOLIDATION_MODEL || 'openai/gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
        },
        {
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          timeout: 30000,
        },
      );

      const content = resp.data.choices?.[0]?.message?.content;
      if (!content) return;

      const extracted = JSON.parse(content);
      const entityTypes = ['interests', 'values', 'desires', 'beliefs', 'intents', 'skills'];
      for (const type of entityTypes) {
        if (Array.isArray(extracted[type]) && extracted[type].length > 0) {
          await this.updateProfileEntities(userId, type.slice(0, -1), extracted[type]); // remove 's'
        }
      }
    } catch (e) {
      this.logger.error(`consolidateFromChat error: ${e.message}`);
    }
  }
}
