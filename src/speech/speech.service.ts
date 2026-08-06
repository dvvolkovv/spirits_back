// src/speech/speech.service.ts
import { createHash } from 'crypto';
import { TtsProvider } from './voices';

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
