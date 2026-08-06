// src/speech/speech.service.ts
import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { StorageService } from '../common/services/storage.service';
import { MiscService } from '../misc/misc.service';
import { LanguageService } from '../common/services/language.service';
import { RedisService } from '../common/services/redis.service';
import { resolveVoice, TtsProvider } from './voices';
import { synthesizeYandex } from './providers/yandex';
import { synthesizeOpenai } from './providers/openai';

const SPEECH_BUCKET = process.env.SPEECH_BUCKET || 'linkeon-assets';
const DEFAULT_ASSISTANT = 'Роман';

export const RATE_LIMIT_PER_MIN = 20;

/**
 * Потолок длины у каждого провайдера свой — единой константы быть не может.
 *
 * Yandex: лимит не на символы, а 15 КБ на тело POST-запроса. В
 * application/x-www-form-urlencoded каждый байт кодируется как %XX, кириллица
 * занимает 2 байта → 6 символов тела на символ текста. Замер: 5000 кириллических
 * символов = 30 005 байт (вдвое сверх лимита), 2000 = 12 005 байт (влезает
 * с запасом). На латинице тот же текст прошёл бы — поэтому баг не ловится
 * короткой тестовой фразой и вылезает на первом длинном русском ответе.
 *
 * OpenAI: у tts-1 жёсткий лимит 4096 символов на input, берём 4000.
 */
const MAX_CHARS_BY_PROVIDER: Record<TtsProvider, number> = {
  yandex: 2000,
  openai: 4000,
};

export function maxCharsFor(provider: TtsProvider): number {
  return MAX_CHARS_BY_PROVIDER[provider];
}

/** 1000 токенов за каждую начатую 1000 символов. */
export function tokenCostFor(chars: number): number {
  return Math.ceil(chars / 1000) * 1000;
}

/** Ключ кэша: текст + голос + язык. Голос обязан входить в ключ. */
export function cacheKeyFor(text: string, voice: string, lang: string): string {
  return createHash('sha256').update(`${text} ${voice} ${lang}`).digest('hex');
}

/**
 * Оценка длительности: ни Yandex, ни OpenAI её не возвращают, а ffprobe в
 * API-процессе ради подписи под плеером не нужен — точное время покажет
 * сам аудио-тег на клиенте.
 */
export function estimateDurationSec(chars: number): number {
  return Math.round((chars / 15) * 100) / 100;
}

export interface SynthesizeInput {
  text: string;
  /** Любой id из каталога. Невалидный молча откатывается на следующий уровень. */
  voice?: string;
}

export type SynthesizeResult =
  | {
      ok: true; clipId: string; audioUrl: string; durationSec: number;
      chars: number; voice: string; provider: TtsProvider;
      tokensSpent: number; cached: boolean;
    }
  | { ok: false; error: 'insufficient_tokens'; balance: number; required: number }
  | { ok: false; error: 'text_too_long'; maxChars: number; provider: TtsProvider }
  | { ok: false; error: 'rate_limited'; retryAfterSec: number }
  | { ok: false; error: string };

@Injectable()
export class SpeechService {
  private readonly logger = new Logger(SpeechService.name);

  constructor(
    private readonly pg: PgService,
    private readonly storage: StorageService,
    private readonly misc: MiscService,
    private readonly language: LanguageService,
    private readonly redis: RedisService,
  ) {}

  async synthesize(userId: string, input: SynthesizeInput): Promise<SynthesizeResult> {
    const text = String(input.text ?? '').trim();
    if (!text) return { ok: false, error: 'empty text' };

    // Потолок 20/мин, а не 10: сценка по ролям — это десяток синтезов подряд
    // в одном ответе ассистента, она не должна упираться в лимит.
    // expire ставим только на первом попадании в окно, иначе TTL продлевается
    // каждым вызовом и окно никогда не закрывается.
    const rlKey = `speech:rl:${userId}`;
    const hits = await this.redis.incr(rlKey);
    if (hits === 1) await this.redis.expire(rlKey, 60);
    if (hits > RATE_LIMIT_PER_MIN) {
      this.logger.warn(`rate limited: user=${userId} hits=${hits}`);
      return { ok: false, error: 'rate_limited', retryAfterSec: 60 };
    }

    const lang = await this.language.resolveUserLanguage(userId);

    // Ассистент берётся из БД, а не из аргументов инструмента: по MCP модель
    // сама подставляет аргументы и может назвать чужого ассистента.
    const profRes = await this.pg.query(
      'SELECT preferred_agent, profile_data FROM ai_profiles_consolidated WHERE user_id = $1',
      [userId],
    );
    const assistantName: string = profRes.rows[0]?.preferred_agent || DEFAULT_ASSISTANT;
    const userChoice: string | undefined =
      profRes.rows[0]?.profile_data?.assistant_voices?.[assistantName];

    const resolved = resolveVoice({ lang, assistantName, userChoice, requested: input.voice });
    for (const r of resolved.rejected) {
      this.logger.warn(`voice rejected: source=${r.source} voice=${r.voice} lang=${lang}`);
    }

    // Потолок длины проверяем только здесь: он зависит от провайдера, а провайдер
    // известен лишь после разрешения языка и голоса.
    const maxChars = maxCharsFor(resolved.provider);
    if (text.length > maxChars) {
      return { ok: false, error: 'text_too_long', maxChars, provider: resolved.provider };
    }

    const cacheKey = cacheKeyFor(text, resolved.voice, lang);
    const hit = await this.pg.query(
      'SELECT id, url, duration_sec, chars FROM speech_clips WHERE user_id = $1 AND cache_key = $2',
      [userId, cacheKey],
    );
    if (hit.rows.length) {
      const row = hit.rows[0];
      return {
        ok: true, clipId: String(row.id), audioUrl: row.url,
        durationSec: Number(row.duration_sec ?? 0), chars: Number(row.chars),
        voice: resolved.voice, provider: resolved.provider, tokensSpent: 0, cached: true,
      };
    }

    const required = tokenCostFor(text.length);
    const balRes = await this.pg.query(
      'SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1',
      [userId],
    );
    const balance = Number(balRes.rows[0]?.tokens ?? 0);
    if (balance < required) return { ok: false, error: 'insufficient_tokens', balance, required };

    let bytes: Buffer;
    try {
      bytes = await this.synthesizeWith(resolved.provider, text, resolved.voice);
    } catch (e: any) {
      this.logger.warn(`synthesize failed (${resolved.provider}/${resolved.voice}): ${e.message}`);
      return { ok: false, error: e?.message || 'tts failed' };
    }

    const key = `audio/${cacheKey}.mp3`;
    const url = await this.storage.upload({
      bucket: SPEECH_BUCKET, key, body: bytes,
      contentType: 'audio/mpeg', cacheControl: 'public, max-age=31536000, immutable',
    });

    const durationSec = estimateDurationSec(text.length);

    // ON CONFLICT обязателен: уникальный индекс (user_id, cache_key) — это и есть
    // механизм кэша, а сценка по ролям шлёт несколько синтезов подряд. Два
    // параллельных вызова с одним текстом иначе дали бы 23505 unique_violation
    // и 500-ку вместо кэш-хита.
    const ins = await this.pg.query(
      `INSERT INTO speech_clips (user_id, assistant_id, cache_key, url, duration_sec, chars, provider, voice, lang)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (user_id, cache_key) DO NOTHING
       RETURNING id`,
      [userId, assistantName, cacheKey, url, durationSec, text.length, resolved.provider, resolved.voice, lang],
    );

    if (ins.rows.length === 0) {
      // Гонку выиграл параллельный вызов — он уже оплатил синтез. Отдаём его клип
      // и второй раз денег не берём.
      const existing = await this.pg.query(
        'SELECT id, url, duration_sec, chars FROM speech_clips WHERE user_id = $1 AND cache_key = $2',
        [userId, cacheKey],
      );
      const row = existing.rows[0];
      return {
        ok: true, clipId: String(row.id), audioUrl: row.url,
        durationSec: Number(row.duration_sec ?? 0), chars: Number(row.chars),
        voice: resolved.voice, provider: resolved.provider, tokensSpent: 0, cached: true,
      };
    }

    // Списываем только после успешного синтеза и заливки.
    await this.misc.deductTokens(userId, required);

    return {
      ok: true, clipId: String(ins.rows[0].id), audioUrl: url, durationSec,
      chars: text.length, voice: resolved.voice, provider: resolved.provider,
      tokensSpent: required, cached: false,
    };
  }

  /** Один ретрай при ошибке провайдера. Фолбэка на другого провайдера нет:
   *  разный тембр на повторе звучит как баг, а не как спасение. */
  private async synthesizeWith(provider: TtsProvider, text: string, voice: string): Promise<Buffer> {
    try {
      return await this.callProvider(provider, text, voice);
    } catch (e: any) {
      this.logger.warn(`tts attempt 1 failed (${provider}/${voice}): ${e.message}, retrying`);
      return await this.callProvider(provider, text, voice);
    }
  }

  /** Выделено отдельным методом, чтобы тесты подменяли сеть одной строкой. */
  private async callProvider(provider: TtsProvider, text: string, voice: string): Promise<Buffer> {
    return provider === 'yandex' ? synthesizeYandex(text, voice) : synthesizeOpenai(text, voice);
  }

  async getClip(userId: string, clipId: string): Promise<any | null> {
    const res = await this.pg.query(
      'SELECT id, url, duration_sec, chars, voice, provider, lang, created_at FROM speech_clips WHERE id = $1 AND user_id = $2',
      [clipId, userId],
    );
    return res.rows[0] ?? null;
  }
}
