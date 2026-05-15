// src/smm/producer/trends.service.ts
import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { RedisService } from '../../common/services/redis.service';

const CACHE_KEY = 'smm:trends:cache';
const CACHE_TTL_SEC = 6 * 3600; // 6 hours

@Injectable()
export class TrendsService {
  private readonly logger = new Logger(TrendsService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Returns a multi-line string with ~10 short trend topic ideas suitable
   * for SMM video cases. Cached in Redis for 6h to avoid hammering Perplexity.
   * On error or missing API key — returns null (caller falls back to 'auto' mode).
   */
  async fetchTrendingTopics(): Promise<string | null> {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) {
      this.logger.warn('PERPLEXITY_API_KEY not set, trends unavailable');
      return null;
    }

    // Cache hit?
    try {
      const cached = await this.redis.get(CACHE_KEY);
      if (cached) {
        this.logger.debug('trends cache hit');
        return cached;
      }
    } catch (e: any) {
      this.logger.warn(`redis get failed: ${e.message}`);
    }

    const prompt = `Какие сейчас обсуждаемые в русскоязычных соцсетях (Telegram, VK, TikTok) темы из жанра "узнаваемая боль" — где люди делятся проблемами из жизни и просят совета?

Темы должны подходить для коротких видео-кейсов, где AI-психолог/юрист/коуч даёт быстрый совет. Дай 10 коротких заголовков-кейсов, каждый в одну строку, без нумерации, разделённые \\n. Например:
"Тревога перед увольнением, мысли крутятся ночами"
"Развод и раздел квартиры, как защитить детей"

Только список из 10 строк, без вступлений.`;

    try {
      const r = await axios.post(
        'https://api.perplexity.ai/chat/completions',
        {
          model: 'sonar',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 800,
        },
        {
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          timeout: 30000,
          validateStatus: () => true,
        },
      );
      if (r.status !== 200) {
        this.logger.warn(`Perplexity ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
        return null;
      }
      const text: string = r.data?.choices?.[0]?.message?.content ?? '';
      if (!text) return null;

      // Cache for 6 hours using RedisService.set(key, value, ttlSeconds)
      try {
        await this.redis.set(CACHE_KEY, text.trim(), CACHE_TTL_SEC);
      } catch (e: any) {
        this.logger.warn(`redis set failed: ${e.message}`);
      }

      return text.trim();
    } catch (e: any) {
      this.logger.warn(`Perplexity call failed: ${e.message}`);
      return null;
    }
  }
}
