import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
import neo4j, { Driver, Session } from 'neo4j-driver';
import axios from 'axios';
import { PgService } from '../common/services/pg.service';

@Injectable()
export class Neo4jService implements OnModuleInit, OnModuleDestroy {
  private driver: Driver | null = null;
  private readonly logger = new Logger(Neo4jService.name);

  constructor(@Optional() private readonly pg?: PgService) {}

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

  async getProfileEntities(userId: string): Promise<any> {
    const session = this.getSession();
    if (!session) return null;
    try {
      const richExpr = (rel: string, label: string) =>
        `[(p)-[:${rel}]->(n:${label}) | {name: n.name, gloss: coalesce(n.gloss, ''), aliases: coalesce(n.aliases, [n.name]), support: coalesce(n.support, 1)}]`;

      const result = await session.run(
        `MATCH (p:Profile {phone: $phone})
         RETURN
           COALESCE(p.name, '') AS name,
           COALESCE(p.family_name, '') AS family_name,
           ${richExpr('HAS_VALUE', 'Value')} AS valuesRich,
           ${richExpr('HAS_BELIEF', 'Belief')} AS beliefsRich,
           ${richExpr('HAS_DESIRE', 'Desire')} AS desiresRich,
           ${richExpr('HAS_INTENT', 'Intent')} AS intentsRich,
           ${richExpr('HAS_INTEREST', 'Interest')} AS interestsRich,
           ${richExpr('HAS_SKILL', 'Skill')} AS skillsRich`,
        { phone: userId },
      );
      if (!result.records.length) return null;
      const rec = result.records[0];
      const toRich = (arr: any[]) =>
        (arr || [])
          .filter((x) => x?.name)
          .map((x) => ({
            name: x.name,
            gloss: x.gloss || '',
            aliases: Array.isArray(x.aliases) ? x.aliases : [x.name],
            support: typeof x.support === 'number' ? x.support : (x.support?.toNumber?.() ?? 1),
          }))
          .sort((a, b) => b.support - a.support); // «жирные» группы выше
      const vRich = toRich(rec.get('valuesRich'));
      const bRich = toRich(rec.get('beliefsRich'));
      const dRich = toRich(rec.get('desiresRich'));
      const intRich = toRich(rec.get('intentsRich'));
      const iRich = toRich(rec.get('interestsRich'));
      const sRich = toRich(rec.get('skillsRich'));
      return {
        name: rec.get('name') || undefined,
        family_name: rec.get('family_name') || undefined,
        // Плоские string-массивы для обратной совместимости со старым фронтом.
        values: vRich.map((x) => x.name),
        beliefs: bRich.map((x) => x.name),
        desires: dRich.map((x) => x.name),
        intents: intRich.map((x) => x.name),
        interests: iRich.map((x) => x.name),
        skills: sRich.map((x) => x.name),
        // Rich-формат с gloss/aliases/support — для нового UI (tooltip/expandable card).
        valuesRich: vRich,
        beliefsRich: bRich,
        desiresRich: dRich,
        intentsRich: intRich,
        interestsRich: iRich,
        skillsRich: sRich,
      };
    } catch (e) {
      this.logger.error(`getProfileEntities error: ${e.message}`);
      return null;
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
      for (const valueName of values) {
        const name = valueName?.trim();
        if (!name) continue;
        const canonicalKey = name.toLowerCase();
        await session.run(
          `MERGE (p:Profile {phone: $phone})
           MERGE (v:${type} {canonical_key: $canonicalKey})
             ON CREATE SET v.name = $name,
                           v.aliases = [$name],
                           v.gloss = '',
                           v.evidence = [],
                           v.support = 1
             ON MATCH  SET v.support = coalesce(v.support, 1) + 1,
                           v.aliases = CASE
                             WHEN $name IN coalesce(v.aliases, []) THEN v.aliases
                             ELSE coalesce(v.aliases, []) + [$name]
                           END
           MERGE (p)-[r:${rel}]->(v)
             ON CREATE SET r.created_at = datetime(), r.confidence = 5
             ON MATCH  SET r.updated_at = datetime()`,
          { phone: userId, name, canonicalKey },
        );
      }
    } catch (e) {
      this.logger.error(`updateProfileEntities error: ${e.message}`);
    } finally {
      await session.close();
    }
  }

  /** Replace all entities of a type: delete old relationships, create new ones */
  async replaceEntities(userId: string, entityType: string, values: string[]): Promise<void> {
    const session = this.getSession();
    if (!session) return;
    const type = entityType.charAt(0).toUpperCase() + entityType.slice(1).toLowerCase();
    const rel = `HAS_${type.toUpperCase()}`;
    try {
      const keys = values.map((v) => v?.trim().toLowerCase()).filter(Boolean);
      // Удаляем связь, только если её canonical_key не пришёл в новом списке.
      // Сам узел не трогаем — другие профили могут быть с ним связаны.
      await session.run(
        `MATCH (p:Profile {phone: $phone})-[r:${rel}]->(n:${type})
         WHERE NOT coalesce(n.canonical_key, toLower(trim(n.name))) IN $keys
         DELETE r`,
        { phone: userId, keys },
      );
      for (const raw of values) {
        const name = raw?.trim();
        if (!name) continue;
        const canonicalKey = name.toLowerCase();
        await session.run(
          `MERGE (p:Profile {phone: $phone})
           MERGE (v:${type} {canonical_key: $canonicalKey})
             ON CREATE SET v.name = $name,
                           v.aliases = [$name],
                           v.gloss = '',
                           v.evidence = [],
                           v.support = 1
             ON MATCH  SET v.aliases = CASE
                             WHEN $name IN coalesce(v.aliases, []) THEN v.aliases
                             ELSE coalesce(v.aliases, []) + [$name]
                           END
           MERGE (p)-[r:${rel}]->(v)
             ON CREATE SET r.created_at = datetime(), r.confidence = 5
             ON MATCH  SET r.updated_at = datetime()`,
          { phone: userId, name, canonicalKey },
        );
      }
      this.logger.log(`replaceEntities: ${type} for ${userId} → ${values.length} items`);
    } catch (e) {
      this.logger.error(`replaceEntities error: ${e.message}`);
    } finally {
      await session.close();
    }
  }

  /**
   * Достаёт предыдущую (пред-предпоследнюю в текущем порядке) реплику ассистента
   * из истории чата. Нужна для распознавания согласия пользователя: «да, точно»
   * без контекста бессмысленно — нужно знать с чем согласился.
   *
   * На момент вызова в DB уже лежат свежие human + ai сообщения (current turn),
   * поэтому используем OFFSET 1, чтобы пропустить только что сохранённый ai-row.
   */
  private async fetchPrevAssistantMessage(userId: string, agentId: string): Promise<string> {
    if (!this.pg) return '';
    try {
      const sessionId = `${userId}_${agentId}`;
      const res = await this.pg.query(
        `SELECT content FROM custom_chat_history
         WHERE session_id = $1 AND sender_type = 'ai'
         ORDER BY created_at DESC LIMIT 1 OFFSET 1`,
        [sessionId],
      );
      return res.rows[0]?.content || '';
    } catch {
      return '';
    }
  }

  /**
   * Толерантный парсер JSON: вырезает первый сбалансированный {...} блок
   * из ответа модели. Терпит обёртку в ```json ```, ведущую/хвостовую прозу,
   * лишние пробелы. Возвращает null если структуры найти не удалось.
   */
  private extractJsonObject(text: string): any | null {
    if (!text) return null;
    let s = text.trim();
    // Strip ```json ... ``` or ``` ... ```
    if (s.startsWith('```')) {
      s = s.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
    }
    // Optimistic direct parse
    try { return JSON.parse(s); } catch {}
    // Find first balanced {...} substring (respects strings + escapes)
    const start = s.indexOf('{');
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { if (inStr) esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
        }
      }
    }
    return null;
  }

  async consolidateFromChat(
    userId: string,
    agentId: string,
    userMessage: string,
    assistantResponse: string,
  ): Promise<void> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if ((!apiKey && !anthropicKey) || !this.driver) return;

    try {
      // Получаем предыдущую реплику ассистента — нужна чтобы понять, с чем
      // именно соглашается пользователь, если в его текущей реплике есть «да/точно/верно».
      const prevAssistant = await this.fetchPrevAssistantMessage(userId, agentId);

      const prompt = `Извлеки психологический профиль ТОЛЬКО на основе того, что ЯВНО говорит сам пользователь о себе.

ЖЁСТКИЕ ПРАВИЛА:
1. Источник извлечения — ИСКЛЮЧИТЕЛЬНО реплика пользователя. Из реплик ассистента извлекать ЗАПРЕЩЕНО, даже если ассистент описывает пользователя или предполагает что-то о нём.
2. Извлекай только если:
   (а) пользователь прямо говорит о себе («я ценю…», «я верю что…», «меня интересует…», «я работаю…», «я хочу…», «я умею…», «я не люблю…»), ИЛИ
   (б) пользователь явно соглашается с конкретным утверждением, которое сказал ассистент в предыдущей реплике («да, точно», «верно», «правильно», «именно так», «согласен», «это про меня», «в точку»). В этом случае посмотри предыдущую реплику ассистента и извлеки именно ту сущность, с которой пользователь согласился.
3. НЕ извлекай если:
   - пользователь только задаёт вопросы или просит что-то посчитать/объяснить
   - реплика нейтральная, без самораскрытия и без явного согласия
   - пользователь выражает сомнение, частичное согласие или возражение («возможно», «не совсем», «не уверен», «нет», «не согласен»)
   - ассистент сделал предположение, а пользователь его не подтвердил
4. Лучше пропустить, чем приписать пользователю то, чего он явно не утверждал.

Категории:
- interests — темы/области, к которым пользователь сам проявил интерес о себе
- values — то что пользователь явно назвал ценным для себя
- desires — желания/цели, о которых пользователь явно сказал
- beliefs — убеждения о мире/себе, которые пользователь явно высказал
- intents — намерения сделать что-то конкретное в ближайшее время, явно высказанные пользователем
- skills — навыки/умения, которые пользователь явно у себя признал

Предыдущая реплика ассистента (нужна ТОЛЬКО для понимания согласий пользователя; извлекать из неё ЗАПРЕЩЕНО):
"""
${prevAssistant ? prevAssistant.slice(0, 3000) : '(пусто — начало диалога)'}
"""

Реплика пользователя (это основной и единственный источник для извлечения):
"""
${userMessage.slice(0, 3000)}
"""

Текущая реплика ассистента (только контекст; извлекать из неё ЗАПРЕЩЕНО):
"""
${assistantResponse.slice(0, 1500)}
"""

Верни валидный JSON и НИЧЕГО кроме него:
{"interests":[],"values":[],"desires":[],"beliefs":[],"intents":[],"skills":[]}

Если пользователь не сказал и явно не согласился ни с чем — верни все массивы пустыми.`;

      let content: string | null = null;
      if (anthropicKey) {
        const Anthropic = require('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey: anthropicKey });
        const msg = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        });
        content = msg.content?.[0]?.text || null;
      } else if (apiKey) {
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
        content = resp.data.choices?.[0]?.message?.content;
      }
      if (!content) return;

      const extracted = this.extractJsonObject(content);
      if (!extracted) {
        this.logger.warn(`consolidateFromChat: failed to parse JSON for ${userId}_${agentId}; raw[0..200]=${content.slice(0, 200)}`);
        return;
      }
      const entityTypes = ['interests', 'values', 'desires', 'beliefs', 'intents', 'skills'];
      for (const type of entityTypes) {
        if (Array.isArray(extracted[type]) && extracted[type].length > 0) {
          await this.updateProfileEntities(userId, type.slice(0, -1), extracted[type]); // remove 's'
        }
      }
      // Update embedding every 5th consolidation (save on API costs)
      const session2 = this.getSession();
      if (session2) {
        try {
          const res = await session2.run(
            'MATCH (p:Profile {phone: $phone}) RETURN p.consolidation_count as cnt, p.embeddingUpdatedAt as emb',
            { phone: userId },
          );
          const cnt = (res.records[0]?.get('cnt')?.toNumber?.() || res.records[0]?.get('cnt') || 0) + 1;
          await session2.run(
            'MERGE (p:Profile {phone: $phone}) SET p.consolidation_count = $cnt',
            { phone: userId, cnt },
          );
          // Update embedding every 5 consolidations or if never set
          const hasEmbedding = res.records[0]?.get('emb');
          if (!hasEmbedding || cnt % 5 === 0) {
            await this.updateProfileEmbedding(userId);
          }
        } finally {
          await session2.close();
        }
      }
    } catch (e) {
      this.logger.error(`consolidateFromChat error: ${e.message}`);
    }
  }

  async updateProfileEmbedding(userId: string): Promise<void> {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey || !this.driver) return;

    try {
      // Build text description from profile entities
      const desc = await this.getProfileDescription(userId);
      if (!desc || desc.length < 20) return;

      // Get embedding from OpenAI
      const resp = await axios.post(
        'https://api.openai.com/v1/embeddings',
        { model: 'text-embedding-3-large', input: desc, dimensions: 256 },
        { headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' }, timeout: 15000 },
      );
      const embedding = resp.data?.data?.[0]?.embedding;
      if (!embedding || !Array.isArray(embedding)) return;

      // Store embedding in Neo4j
      const session = this.getSession();
      if (!session) return;
      try {
        await session.run(
          'MERGE (p:Profile {phone: $phone}) SET p.embedding = $embedding, p.embeddingUpdatedAt = datetime()',
          { phone: userId, embedding },
        );
        this.logger.log(`Embedding updated for ${userId} (${embedding.length} dims)`);
      } finally {
        await session.close();
      }
    } catch (e) {
      this.logger.error(`updateProfileEmbedding error: ${e.message}`);
    }
  }

  async getQueryEmbedding(query: string): Promise<number[] | null> {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) return null;
    try {
      const resp = await axios.post(
        'https://api.openai.com/v1/embeddings',
        { model: 'text-embedding-3-large', input: query, dimensions: 256 },
        { headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' }, timeout: 15000 },
      );
      return resp.data?.data?.[0]?.embedding || null;
    } catch (e) {
      this.logger.error(`getQueryEmbedding error: ${e.message}`);
      return null;
    }
  }
}
