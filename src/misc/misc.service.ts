import { Injectable, Logger } from '@nestjs/common';
import { Neo4jService } from '../neo4j/neo4j.service';
import { PgService } from '../common/services/pg.service';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import axios from 'axios';
import { Response } from 'express';

@Injectable()
export class MiscService {
  private readonly logger = new Logger(MiscService.name);
  private s3: S3Client;
  private readonly s3Bucket = process.env.AWS_S3_BUCKET || 'linkeon.io';

  constructor(
    private readonly neo4j: Neo4jService,
    private readonly pg: PgService,
  ) {
    this.s3 = new S3Client({
      region: process.env.AWS_REGION || 'ru-central1',
      endpoint: process.env.AWS_ENDPOINT || 'https://storage.yandexcloud.net',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      },
      forcePathStyle: true,
    });
  }

  private async uploadToS3(buffer: Buffer, ext: string): Promise<string> {
    const filename = `images/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const contentType = ext === 'png' ? 'image/png' : 'image/jpeg';
    await this.s3.send(new PutObjectCommand({
      Bucket: this.s3Bucket,
      Key: filename,
      Body: buffer,
      ContentType: contentType,
    }));
    // Return presigned URL valid for 7 days
    const url = await getSignedUrl(this.s3, new GetObjectCommand({
      Bucket: this.s3Bucket,
      Key: filename,
    }), { expiresIn: 7 * 24 * 3600 });
    return url;
  }

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
    const { prompt, quality } = body;
    if (!prompt) throw new Error('Missing prompt');

    const selectedModel = 'google/gemini-2.5-flash-image';
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
          messages: [{ role: 'user', content: prompt }],
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://b.linkeon.io',
          },
          timeout: 120000,
          maxContentLength: 50 * 1024 * 1024,
          maxBodyLength: 50 * 1024 * 1024,
        },
      );

      const choice = response.data?.choices?.[0];
      const message = choice?.message;
      const images: { url: string; revisedPrompt?: string }[] = [];

      // OpenRouter returns images in message.images array as base64
      if (Array.isArray(message?.images)) {
        const fs = require('fs');
        const path = require('path');
        const publicDir = path.join(process.cwd(), 'public', 'generated');
        if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

        for (const img of message.images) {
          const dataUrl = img?.image_url?.url || '';
          if (dataUrl.startsWith('data:image/')) {
            const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
            if (match) {
              const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
              const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
              fs.writeFileSync(path.join(publicDir, filename), Buffer.from(match[2], 'base64'));
              images.push({ url: `/static/generated/${filename}` });
            }
          } else if (dataUrl.startsWith('http')) {
            images.push({ url: dataUrl });
          }
        }
      }

      // Fallback: check content for markdown images
      if (images.length === 0 && typeof message?.content === 'string') {
        const mdRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
        let m;
        while ((m = mdRegex.exec(message.content)) !== null) {
          images.push({ url: m[2], revisedPrompt: m[1] || undefined });
        }
      }

      if (images.length === 0) {
        throw new Error('Модель не вернула изображений. Попробуйте другой промпт.');
      }

      // Deduct tokens
      await this.pg.query(
        'UPDATE ai_profiles_consolidated SET tokens = tokens - $1, updated_at = now() WHERE user_id = $2',
        [tokenCost, userId],
      );

      return { images, tokensSpent: tokenCost };
    } catch (e) {
      if (e.response?.data) {
        this.logger.error(`Image gen API error: ${JSON.stringify(e.response.data).slice(0, 500)}`);
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
