// src/speech/voices.ts
export type TtsProvider = 'yandex' | 'openai';
export type Gender = 'm' | 'f';

export interface VoiceEntry {
  id: string;
  provider: TtsProvider;
  gender: Gender;
  /** Человекочитаемое имя для UI. Не переводим — имя собственное. */
  title: string;
  /** Тембр в двух словах. Уходит в описание инструмента для модели. */
  description: string;
}

/**
 * Каталог обязан содержать только голоса, которые провайдер реально принимает:
 * `resolveVoice` считает валидным любой голос ИЗ каталога, поэтому лишняя запись
 * не отсеивается валидацией, а доходит до провайдера и падает там уже на живом
 * пользователе.
 *
 * Список сверен с боевым API 2026-08-07 прогоном `scripts/generate-voice-samples.ts`.
 * Тогда же выяснилось, что SpeechKit v1 не знает семь голосов, которые попали сюда
 * из документации: dasha, julia, lera, masha, alexander, kirill, anton — все они
 * отвечали `400 Unsupported voice is requested`. Прежде чем добавлять голос,
 * прогони этот скрипт: он и есть проверка каталога на соответствие реальности.
 */
export const VOICE_CATALOG: VoiceEntry[] = [
  // ── Yandex SpeechKit (ru) ────────────────────────────────────────────
  { id: 'alena',     provider: 'yandex', gender: 'f', title: 'Алёна',     description: 'тёплый женский, universal' },
  { id: 'jane',      provider: 'yandex', gender: 'f', title: 'Джейн',     description: 'мягкий женский, подходит для эмпатичных ролей' },
  { id: 'omazh',     provider: 'yandex', gender: 'f', title: 'Омаж',      description: 'деловой женский, спокойный' },
  { id: 'marina',    provider: 'yandex', gender: 'f', title: 'Марина',    description: 'зрелый женский' },
  { id: 'zahar',     provider: 'yandex', gender: 'm', title: 'Захар',     description: 'уверенный мужской, universal' },
  { id: 'filipp',    provider: 'yandex', gender: 'm', title: 'Филипп',    description: 'дружелюбный мужской' },
  { id: 'ermil',     provider: 'yandex', gender: 'm', title: 'Ермил',     description: 'мягкий мужской' },
  { id: 'madirus',   provider: 'yandex', gender: 'm', title: 'Мадирус',   description: 'глубокий мужской, деловой' },

  // ── OpenAI tts-1 (не-ru) ─────────────────────────────────────────────
  // Описания по-английски намеренно: провайдер выбирается по языку пользователя,
  // поэтому эти голоса видит в настройках только не-русскоязычный интерфейс.
  // Русское описание там смотрелось бы чужеродно (каталог отдаётся как данные и
  // на фронте не переводится).
  { id: 'alloy',   provider: 'openai', gender: 'f', title: 'Alloy',   description: 'neutral, even-toned' },
  { id: 'nova',    provider: 'openai', gender: 'f', title: 'Nova',    description: 'warm female' },
  { id: 'shimmer', provider: 'openai', gender: 'f', title: 'Shimmer', description: 'bright female' },
  { id: 'echo',    provider: 'openai', gender: 'm', title: 'Echo',    description: 'steady male' },
  { id: 'onyx',    provider: 'openai', gender: 'm', title: 'Onyx',    description: 'deep male' },
  { id: 'fable',   provider: 'openai', gender: 'm', title: 'Fable',   description: 'narrative, soft' },
];

/** Дефолты по ассистентам. Ключ — имя из agents.name (оно же preferred_agent). */
interface AssistantDefault { gender: Gender; yandex: string; openai: string }

export const ASSISTANT_DEFAULTS: Record<string, AssistantDefault> = {
  'Роман':      { gender: 'm', yandex: 'zahar',   openai: 'onyx' },
  'Миша':       { gender: 'm', yandex: 'filipp',  openai: 'echo' },
  'Андрей':     { gender: 'm', yandex: 'madirus', openai: 'onyx' },
  'Алексей':    { gender: 'm', yandex: 'madirus', openai: 'echo' },
  'Герман':     { gender: 'm', yandex: 'filipp',  openai: 'fable' },
  'Виталий':    { gender: 'm', yandex: 'zahar',   openai: 'fable' },
  'Шанкара':    { gender: 'm', yandex: 'filipp',  openai: 'fable' },
  'Оля':        { gender: 'f', yandex: 'alena',   openai: 'nova' },
  'Маша':       { gender: 'f', yandex: 'jane',    openai: 'shimmer' },
  'Ирина':      { gender: 'f', yandex: 'omazh',   openai: 'nova' },
  'Александра': { gender: 'f', yandex: 'omazh',   openai: 'nova' },
  'Екатерина':  { gender: 'f', yandex: 'alena',   openai: 'alloy' },
  'Анна':       { gender: 'f', yandex: 'alena',   openai: 'alloy' },
  'Лиана':      { gender: 'f', yandex: 'jane',    openai: 'shimmer' },
  'Райя':       { gender: 'f', yandex: 'jane',    openai: 'shimmer' },
  'Павел':      { gender: 'm', yandex: 'zahar',   openai: 'echo' },
  'Полина':     { gender: 'f', yandex: 'omazh',   openai: 'shimmer' },
};

export const GENDER_DEFAULT: Record<Gender, { yandex: string; openai: string }> = {
  m: { yandex: 'zahar', openai: 'onyx' },
  f: { yandex: 'alena', openai: 'nova' },
};

/**
 * Определяет провайдера TTS по языку.
 *
 * Контракт: `lang` должен быть уже нормализованным корневым кодом языка
 * (`ru`, `en`, `de`, `fr`, `es`, `zh`, …) — результатом
 * `LanguageService.resolveUserLanguage()` / `LanguageService.normalize()`
 * на бэкенде. Сырые BCP-47 теги вида `ru-RU` сюда передавать нельзя:
 * сравнение строгое (`lang === 'ru'`), поэтому `ru-RU` не совпадёт с `ru`
 * и молча уедет на openai-ветку. Нормализация — забота вызывающей стороны,
 * не этого модуля.
 */
export function providerForLang(lang: string): TtsProvider {
  return lang === 'ru' ? 'yandex' : 'openai';
}

export function isValidVoice(voiceId: string | undefined, provider: TtsProvider): boolean {
  if (!voiceId) return false;
  return VOICE_CATALOG.some((v) => v.id === voiceId && v.provider === provider);
}

export type VoiceSource = 'requested' | 'user' | 'assistant' | 'gender-default';

export interface ResolveVoiceInput {
  /**
   * Уже нормализованный корневой код языка (`ru`, `en`, `de`, `fr`, `es`,
   * `zh`, …), см. `LanguageService.resolveUserLanguage()` /
   * `LanguageService.normalize()` на бэкенде. Не передавать сырой BCP-47
   * тег (`ru-RU`) — `providerForLang` сравнивает строго и молча отправит
   * его на openai-ветку.
   */
  lang: string;
  assistantName?: string;
  /** profile_data.assistant_voices[assistantName] */
  userChoice?: string;
  /** параметр voice из вызова инструмента */
  requested?: string;
}

export interface ResolvedVoice {
  voice: string;
  provider: TtsProvider;
  source: VoiceSource;
  /** Уровни, отброшенные из-за невалидного голоса — для warn-лога. */
  rejected: Array<{ source: VoiceSource; voice: string }>;
}

/**
 * Четыре уровня приоритета, первый валидный выигрывает. Невалидный голос
 * (выдуманный моделью id или голос чужого провайдера) не роняет вызов —
 * уровень отбрасывается и попадает в `rejected` для лога.
 */
export function resolveVoice(input: ResolveVoiceInput): ResolvedVoice {
  const provider = providerForLang(input.lang);
  const rejected: Array<{ source: VoiceSource; voice: string }> = [];

  const def = input.assistantName ? ASSISTANT_DEFAULTS[input.assistantName] : undefined;
  const gender: Gender = def?.gender ?? 'f';

  const candidates: Array<{ source: VoiceSource; voice: string | undefined }> = [
    { source: 'requested', voice: input.requested },
    { source: 'user', voice: input.userChoice },
    { source: 'assistant', voice: def ? def[provider] : undefined },
    { source: 'gender-default', voice: GENDER_DEFAULT[gender][provider] },
  ];

  for (const c of candidates) {
    if (!c.voice) continue;
    if (isValidVoice(c.voice, provider)) {
      return { voice: c.voice, provider, source: c.source, rejected };
    }
    rejected.push({ source: c.source, voice: c.voice });
  }

  // Недостижимо: gender-default всегда валиден. Оставлено ради тотальности типа.
  return { voice: GENDER_DEFAULT.f[provider], provider, source: 'gender-default', rejected };
}
