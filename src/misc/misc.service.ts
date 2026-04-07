import { Injectable, Logger } from '@nestjs/common';
import { Neo4jService } from '../neo4j/neo4j.service';
import { PgService } from '../common/services/pg.service';
import axios from 'axios';
import { Response } from 'express';

@Injectable()
export class MiscService {
  private readonly logger = new Logger(MiscService.name);

  constructor(
    private readonly neo4j: Neo4jService,
    private readonly pg: PgService,
  ) {}

  async searchMate(userId: string, query: string, res: Response): Promise<void> {
    res.status(200);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Get current user's profile for context
    const userProfile = await this.neo4j.getProfileEntities(userId).catch(() => null);
    const userDesc = userProfile
      ? `Values: ${(userProfile.values || []).slice(0, 10).join(', ')}. Interests: ${(userProfile.interests || []).slice(0, 10).join(', ')}. Desires: ${(userProfile.desires || []).slice(0, 5).join(', ')}`
      : '';

    // Search Neo4j for matching profiles
    const matches = await this.searchProfiles(query, userId);

    // Build LLM prompt
    const systemPrompt = `Ты — помощник по поиску единомышленников. Пользователь ищет людей по запросу.
Профиль пользователя: ${userDesc}

Найденные профили:
${matches.map((m, i) => `${i + 1}. Телефон: ${m.phone}, Ценности: ${m.values.join(', ')}, Интересы: ${m.interests.join(', ')}, Навыки: ${m.skills.join(', ')}`).join('\n')}

Напиши краткий комментарий (2-3 предложения) о результатах поиска.
Затем на отдельной строке напиши search_result: и JSON массив результатов в формате:
[{"id":"phone","name":"Имя","values":["val1"],"intents":[],"interests":[],"skills":[],"corellation":0.8,"phone":"phone"}]
Если совпадений нет, напиши что не нашлось и верни пустой массив search_result:[]`;

    const userMessage = `Запрос поиска: "${query}"`;

    // Stream response
    if (matches.length === 0) {
      const noResults = 'К сожалению, по вашему запросу не найдено подходящих людей. Попробуйте изменить запрос или расширить критерии поиска.\n\nsearch_result:[]';
      res.write(JSON.stringify({ type: 'item', content: noResults }) + '\n');
      res.end();
      return;
    }

    await this.streamLLM(systemPrompt, userMessage, res);
  }

  async analyzeCompatibility(userId: string, targetUsers: string[], res: Response): Promise<void> {
    res.status(200);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Get all profiles
    const myProfile = await this.neo4j.getProfileEntities(userId).catch(() => null);
    const profiles: { phone: string; data: any }[] = [];
    for (const phone of targetUsers) {
      const p = await this.neo4j.getProfileEntities(phone).catch(() => null);
      if (p) profiles.push({ phone, data: p });
    }

    const formatProfile = (p: any) =>
      `Ценности: ${(p.values || []).slice(0, 15).join(', ')}. Убеждения: ${(p.beliefs || []).slice(0, 10).join(', ')}. Желания: ${(p.desires || []).slice(0, 10).join(', ')}. Интересы: ${(p.interests || []).slice(0, 10).join(', ')}. Навыки: ${(p.skills || []).slice(0, 10).join(', ')}`;

    const systemPrompt = `Ты — эксперт по анализу совместимости людей на основе их ценностей, убеждений, желаний, интересов и навыков.

Профиль пользователя (${userId}):
${myProfile ? formatProfile(myProfile) : 'Профиль не найден'}

${profiles.map(p => `Профиль ${p.phone}:\n${formatProfile(p.data)}`).join('\n\n')}

Проанализируй совместимость этих людей. Напиши:
1. Общий процент совместимости
2. Что общего (совпадающие ценности, интересы)
3. Различия и потенциальные точки роста
4. Рекомендации по взаимодействию

Используй markdown форматирование.`;

    if (!myProfile && profiles.length === 0) {
      const msg = 'Не удалось найти профили для анализа. Убедитесь, что указанные номера зарегистрированы в системе.';
      res.write(JSON.stringify({ type: 'item', content: msg }) + '\n');
      res.end();
      return;
    }

    await this.streamLLM(systemPrompt, 'Проанализируй совместимость этих людей', res);
  }

  async generateImage(userId: string, body: any): Promise<any> {
    const { prompt, model, size, quality } = body;
    if (!prompt) throw new Error('Missing prompt');

    const selectedModel = model || 'google/gemini-3-pro-image-preview';
    const tokenCost = quality === 'hd' ? 10000 : 5000;

    // Check token balance
    const balanceRes = await this.pg.query(
      'SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1',
      [userId],
    );
    const currentTokens = Number(balanceRes.rows[0]?.tokens || 0);
    if (currentTokens < tokenCost) {
      throw new Error('Недостаточно токенов');
    }

    try {
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: selectedModel,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://my.linkeon.io',
          },
          timeout: 120000,
        },
      );

      const choice = response.data?.choices?.[0];
      const content = choice?.message?.content;
      const images: { url: string; revisedPrompt?: string }[] = [];

      // Extract image URLs from response
      // OpenRouter image models return markdown images or direct URLs
      if (typeof content === 'string') {
        // Match markdown image syntax: ![...](url)
        const mdImageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
        let match;
        while ((match = mdImageRegex.exec(content)) !== null) {
          images.push({ url: match[2], revisedPrompt: match[1] || undefined });
        }
        // If no markdown images found, check if content itself is a URL
        if (images.length === 0 && content.match(/^https?:\/\/.+/)) {
          images.push({ url: content.trim() });
        }
      }

      // Handle multimodal responses with inline_data
      if (Array.isArray(choice?.message?.content)) {
        for (const part of choice.message.content) {
          if (part.type === 'image_url' && part.image_url?.url) {
            images.push({ url: part.image_url.url });
          }
          if (part.type === 'text' && part.text) {
            const mdImageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
            let match;
            while ((match = mdImageRegex.exec(part.text)) !== null) {
              images.push({ url: match[2], revisedPrompt: match[1] || undefined });
            }
          }
        }
      }

      if (images.length === 0) {
        throw new Error('Модель не вернула изображений. Попробуйте другую модель или уточните промпт.');
      }

      // Deduct tokens
      await this.pg.query(
        'UPDATE ai_profiles_consolidated SET tokens = tokens - $1, updated_at = now() WHERE user_id = $2',
        [tokenCost, userId],
      );

      return { images, tokensSpent: tokenCost };
    } catch (e) {
      if (e.response?.data) {
        this.logger.error(`Image gen API error: ${JSON.stringify(e.response.data)}`);
      }
      throw new Error(e.message || 'Image generation failed');
    }
  }

  private async searchProfiles(query: string, excludePhone: string): Promise<any[]> {
    try {
      const session = (this.neo4j as any).getSession();
      if (!session) return [];

      // Simple keyword search: match profiles that have values/interests/skills matching the query
      const result = await session.run(
        `MATCH (p:Profile)
         WHERE p.phone <> $exclude
         WITH p,
           [(p)-[:HAS_VALUE]->(v:Value) | v.name] AS values,
           [(p)-[:HAS_INTEREST]->(i:Interest) | i.name] AS interests,
           [(p)-[:HAS_SKILL]->(s:Skill) | s.name] AS skills,
           [(p)-[:HAS_DESIRE]->(d:Desire) | d.name] AS desires,
           [(p)-[:HAS_INTENT]->(it:Intent) | it.name] AS intents
         WHERE size(values) + size(interests) + size(skills) > 0
         RETURN p.phone AS phone, COALESCE(p.name, '') AS name,
                values, interests, skills, desires, intents
         LIMIT 10`,
        { exclude: excludePhone },
      );

      await session.close();
      return result.records.map(r => ({
        phone: r.get('phone'),
        name: r.get('name'),
        values: r.get('values').filter(Boolean),
        interests: r.get('interests').filter(Boolean),
        skills: r.get('skills').filter(Boolean),
        desires: r.get('desires').filter(Boolean),
        intents: r.get('intents').filter(Boolean),
      }));
    } catch (e) {
      this.logger.error(`searchProfiles error: ${e.message}`);
      return [];
    }
  }

  private async streamLLM(systemPrompt: string, userMessage: string, res: Response): Promise<void> {
    const chunks: string[] = [];
    try {
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'openai/gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          stream: true,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://my.linkeon.io',
          },
          responseType: 'stream',
          timeout: 120000,
        },
      );

      await new Promise<void>((resolve, reject) => {
        let buffer = '';
        response.data.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === 'data: [DONE]') continue;
            if (!trimmed.startsWith('data: ')) continue;
            try {
              const json = JSON.parse(trimmed.substring(6));
              const content = json.choices?.[0]?.delta?.content;
              if (content) {
                chunks.push(content);
                res.write(JSON.stringify({ type: 'item', content }) + '\n');
              }
            } catch {}
          }
        });
        response.data.on('end', () => resolve());
        response.data.on('error', (err: Error) => reject(err));
      });
    } catch (e) {
      this.logger.error(`LLM stream error: ${e.message}`);
      const errMsg = 'Ошибка при обработке запроса.';
      chunks.push(errMsg);
      res.write(JSON.stringify({ type: 'item', content: errMsg }) + '\n');
    }

    res.end();
  }
}
