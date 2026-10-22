// src/video/video.dto.ts
import { IsString, IsOptional, IsNumber, IsIn, IsArray, IsBoolean, Min, Max } from 'class-validator';

// Единственный движок — Veo 3.1 (Google): long-form talking-head with native
// audio + portrait consistency, via the Gemini Developer API. backlog a0132032.
// Kling снят 22.10.2026 вместе с режимами extend и lipsync: в старых строках
// video_jobs они остаются как история, новых таких задач нет.
export type VideoMode = 'text2video' | 'image2video';
export type VideoModel = 'veo-3.1-fast' | 'veo-3.1';

export const VEO_MODELS: VideoModel[] = ['veo-3.1-fast', 'veo-3.1'];
export function isVeoModel(model: string): boolean {
  return (VEO_MODELS as string[]).includes(model);
}
export function veoTier(model: string): 'fast' | 'standard' {
  return model === 'veo-3.1' ? 'standard' : 'fast';
}
export type VideoStatus = 'pending' | 'processing' | 'ready' | 'failed';

export class CreateVideoJobDto {
  @IsIn(['text2video', 'image2video'])
  mode!: VideoMode;

  @IsOptional() @IsIn(['veo-3.1-fast', 'veo-3.1'])
  model?: VideoModel;

  // Длина ролика. Veo генерирует базу 8с и продлевает её по 7с (или клеит
  // 8с-клипы для 9:16), итог режется ровно до этой длины. По умолчанию 8.
  @IsOptional() @IsNumber() @Min(5) @Max(60)
  targetDurationSec?: number;

  @IsOptional() @IsString()
  prompt?: string;

  @IsOptional() @IsString()
  negativePrompt?: string;

  // Veo: формат вывода. 9:16 для соцсетей/Reels (фидбэк katya — не было выбора,
  // мы хардкодили 16:9). Если не задан — авто-детект «вертикальное/reels» из
  // промпта, иначе 16:9.
  @IsOptional() @IsIn(['16:9', '9:16'])
  aspectRatio?: '16:9' | '9:16';

  // Veo: разрешение базового сегмента. 1080p даёт детализацию (поры/кожа) —
  // 720p выглядел «пластиково». Extend у Veo всегда 720p (ограничение API),
  // поэтому 1080p эффективен на коротких (≤8с) роликах.
  @IsOptional() @IsIn(['720p', '1080p'])
  resolution?: '720p' | '1080p';

  @IsOptional() @IsString()
  sourceImageUrl?: string;

  // Veo image2video: до 3 референс-фото (Ingredients) — сильно лучше сходство
  // лица с несколькими ракурсами (фидбэк katya). Приоритетнее sourceImageUrl.
  @IsOptional() @IsArray() @IsString({ each: true })
  sourceImageUrls?: string[];

  // «Голосом оригинала» (96cba3f7): только Veo. После генерации финальная
  // аудиодорожка заменяется на голос пользователя (clone + speech-to-speech),
  // тайминг/липсинк сохраняются. Требует готового user_voice.
  @IsOptional() @IsBoolean()
  ownVoice?: boolean;
}

export interface ComposedPlan {
  target_duration_sec: number;
  segments_total: number;
  segments_done: number;
  segment_kling_video_ids: string[];   // имя историческое; у Veo — id сегментов
  segment_video_urls: string[];
  // --- Veo provider (native extend chain — one continuous video, no concat) ---
  provider?: 'kling' | 'veo';   // 'kling' — только в старых строках
  veo_tier?: 'fast' | 'standard';
  veo_aspect_ratio?: '16:9' | '9:16';   // формат базы (extend наследует)
  veo_resolution?: '720p' | '1080p';    // разрешение базы (extend всегда 720p)
  veo_reference_images?: string[];       // URL референс-фото (Ingredients, B)
  // 9:16 + >8с: вместо native extend (он только 16:9) генерим N независимых
  // 8с-клипов и ffmpeg-concat'им их (с сохранением звука). segment_video_urls
  // здесь не используется — клипы складываются в локальные part-файлы по
  // соглашению об именах, см. video.service.composeVeoClips.
  veo_concat?: boolean;
  veo_last_uri?: string | null;   // download uri of the latest (cumulative) clip
  // Per-segment prompts. The user's script/speech is distributed across the
  // segments so Veo speaks it ONCE end-to-end instead of repeating the full
  // line in every 8s segment (a0132032 fix). Index = segment number; base uses
  // [0], extend N uses [N]. Empty tail segments get a no-speech continuation.
  veo_segment_prompts?: string[];
  // Retry counter for the segment currently in flight. Reset to 0 every
  // time a segment finishes successfully; bumped when we re-submit after
  // a transient error. Capped server-side.
  current_segment_attempt?: number;
  // Retry counter for TRANSIENT Veo operation-result errors (operation accepted
  // ok, но рендеринг упал с "internal server issue" / 500 — Google просит
  // повторить). Отдельный от current_segment_attempt, т.к. тот сбрасывается при
  // старте extend в Phase 2 и не накапливался бы. Сбрасывается при успехе сегмента.
  veo_op_retries?: number;
  // ISO timestamp set when concat starts. Used as an optimistic lock so a
  // concurrent poller tick can't enter composeVeoClips for the same job.
  concat_started_at?: string;
}

// Строка video_jobs. mode и model — строки, а не VideoMode/VideoModel: в
// истории остались задачи Kling (kling-v1-6, extend, lipsync).
export interface VideoJobRow {
  id: string;
  user_id: string;
  mode: string;
  model: string;
  quality: string;
  duration_sec: number;
  prompt: string | null;
  negative_prompt: string | null;
  cfg_scale: number | null;
  source_image_url: string | null;
  source_video_id: string | null;
  camera_type: string | null;
  camera_config: Record<string, any> | null;
  audio_url: string | null;
  tokens_spent: number;
  kling_task_id: string | null;   // имя историческое; у Veo — имя операции
  status: VideoStatus;
  video_url: string | null;
  thumbnail_url: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  target_duration_sec: number | null;
  composed_plan: ComposedPlan | null;
  own_voice?: boolean;
}

// Veo 3.1 quote: base 8s + N×7s native extends, output trimmed to target.
// User pricing set by the owner 2026-06-03: ~2× cost ("доступная"), i.e. a 24s
// Fast clip ≈ 700₽ ≈ 280k tokens (ref ~2.5₽/1000 tokens; our cost ~360₽/24s).
// → Fast base(8s) 90k, +7s extend 63k. Standard ≈ 2.7× Fast (cost $0.40 vs $0.15/s).
const VEO_BASE_SEC = 8;
const VEO_EXTEND_SEC = 7;
const VEO_PRICING: Record<'fast' | 'standard', { base: number; extendUnit: number }> = {
  fast:     { base: 90_000,  extendUnit: 63_000 },
  standard: { base: 240_000, extendUnit: 170_000 },
};
export interface VeoQuote {
  tier: 'fast' | 'standard';
  segments: number;        // 1 base + N extends
  rawDurationSec: number;  // generated seconds before trim
  totalCost: number;       // tokens
}
export function computeVeoQuote(model: VideoModel, targetDurationSec: number): VeoQuote {
  const tier = veoTier(model);
  const p = VEO_PRICING[tier];
  const extendCount = Math.ceil(Math.max(0, targetDurationSec - VEO_BASE_SEC) / VEO_EXTEND_SEC);
  return {
    tier,
    segments: 1 + extendCount,
    rawDurationSec: VEO_BASE_SEC + extendCount * VEO_EXTEND_SEC,
    totalCost: p.base + extendCount * p.extendUnit,
  };
}

// Вертикальные ролики (9:16) длиннее 8с: Veo native extend работает ТОЛЬКО в
// 16:9 (API: "Aspect ratio of the input video must be 16:9"). Поэтому длинную
// вертикаль собираем как ffmpeg-concat независимых 8с-клипов — автоматизация
// ручной склейки, о которой писала katya. Каждый клип = полная базовая
// генерация (нет «дешёвого» extend), поэтому цена = N × base (решение владельца
// 2026-06-06: «по факту N×база»). Каждый клип несёт свою порцию реплики
// (buildVeoSegmentPrompts) — монолог течёт сквозь стыки.
export function computeVeoConcatQuote(model: VideoModel, targetDurationSec: number): VeoQuote {
  const tier = veoTier(model);
  const p = VEO_PRICING[tier];
  const clips = Math.max(1, Math.ceil(targetDurationSec / VEO_BASE_SEC));
  return {
    tier,
    segments: clips,
    rawDurationSec: clips * VEO_BASE_SEC,
    totalCost: clips * p.base,
  };
}

// Надбавка за «видео голосом оригинала» = себестоимость ElevenLabs speech-to-speech
// × тот же markup, что у Veo. Veo-основа (комментарий выше): fast $0.15/с → 90k
// токенов за 8с = $1.20 ⇒ 75 000 токенов за $1 (сходится на standard: $0.40/с →
// 240k/8с). STS биллится по символам; символы ролика ≈ длительность × ~15 симв/с;
// публичная ставка ElevenLabs ~$0.30 за 1000 символов. Итого ≈ 338 токенов/сек —
// мизер против Veo (90k/8с). Подтверждено владельцем 2026-06-26 (96cba3f7).
const STS_CHARS_PER_SEC = 15;
const STS_USD_PER_1K_CHARS = 0.30;
const VOICE_TOKENS_PER_USD = 75_000;
export function computeOwnVoiceSurcharge(targetDurationSec: number): number {
  const sec = Math.max(1, Math.round(targetDurationSec || 0));
  const chars = sec * STS_CHARS_PER_SEC;
  const usd = (chars / 1000) * STS_USD_PER_1K_CHARS;
  return Math.ceil(usd * VOICE_TOKENS_PER_USD);
}
