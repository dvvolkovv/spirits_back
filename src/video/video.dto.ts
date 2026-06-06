// src/video/video.dto.ts
import { IsString, IsOptional, IsNumber, IsIn, IsObject, IsArray, Min, Max } from 'class-validator';

export type VideoMode = 'text2video' | 'image2video' | 'extend' | 'lipsync';
export type VideoModel = 'kling-v1-6' | 'kling-v2-master' | 'veo-3.1-fast' | 'veo-3.1';
export type VideoQuality = 'std' | 'pro';

// Veo 3.1 (Google) — long-form talking-head with native audio + portrait
// consistency, via the Gemini Developer API. backlog a0132032.
export const VEO_MODELS: VideoModel[] = ['veo-3.1-fast', 'veo-3.1'];
export function isVeoModel(model: string): boolean {
  return (VEO_MODELS as string[]).includes(model);
}
export function veoTier(model: VideoModel): 'fast' | 'standard' {
  return model === 'veo-3.1' ? 'standard' : 'fast';
}
export type VideoStatus = 'pending' | 'processing' | 'ready' | 'failed';

export class CreateVideoJobDto {
  @IsIn(['text2video', 'image2video', 'extend', 'lipsync'])
  mode!: VideoMode;

  @IsOptional() @IsIn(['kling-v1-6', 'kling-v2-master', 'veo-3.1-fast', 'veo-3.1'])
  model?: VideoModel;

  @IsOptional() @IsIn(['std', 'pro'])
  quality?: VideoQuality;

  @IsOptional() @IsIn([5, 10])
  duration?: 5 | 10;

  // Composed long-form video. When > 10, backend plans a chain of Kling
  // calls (base 10s + N × extend 5s) and ffmpeg-concats the result down to
  // exactly this duration. Only valid for text2video / image2video.
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

  @IsOptional() @IsNumber() @Min(0) @Max(1)
  cfgScale?: number;

  @IsOptional() @IsString()
  sourceImageUrl?: string;

  // Veo image2video: до 3 референс-фото (Ingredients) — сильно лучше сходство
  // лица с несколькими ракурсами (фидбэк katya). Приоритетнее sourceImageUrl.
  @IsOptional() @IsArray() @IsString({ each: true })
  sourceImageUrls?: string[];

  @IsOptional() @IsString()
  sourceVideoId?: string;

  @IsOptional() @IsIn(['simple','down_back','forward_up','right_turn_forward','left_turn_forward'])
  cameraType?: string;

  @IsOptional() @IsObject()
  cameraConfig?: Record<string, number>;

  @IsOptional() @IsString()
  audioUrl?: string;
}

export interface ComposedPlan {
  target_duration_sec: number;
  segments_total: number;
  segments_done: number;
  segment_kling_video_ids: string[];
  segment_video_urls: string[];
  // --- Veo provider (native extend chain — one continuous video, no concat) ---
  provider?: 'kling' | 'veo';
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
  // a transient Kling error (e.g. "Internal error"). Capped server-side.
  current_segment_attempt?: number;
  // Retry counter for TRANSIENT Veo operation-result errors (operation accepted
  // ok, но рендеринг упал с "internal server issue" / 500 — Google просит
  // повторить). Отдельный от current_segment_attempt, т.к. тот сбрасывается при
  // старте extend в Phase 2 и не накапливался бы. Сбрасывается при успехе сегмента.
  veo_op_retries?: number;
  // ISO timestamp set when concat starts. Used as an optimistic lock so a
  // concurrent poller tick can't enter composeFinalVideo for the same job.
  concat_started_at?: string;
}

export interface VideoJobRow {
  id: string;
  user_id: string;
  mode: VideoMode;
  model: VideoModel;
  quality: VideoQuality;
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
  kling_task_id: string | null;
  status: VideoStatus;
  video_url: string | null;
  thumbnail_url: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  target_duration_sec: number | null;
  composed_plan: ComposedPlan | null;
}

export const VIDEO_PRICING: Record<string, number> = {
  'text2video.kling-v1-6.std.5':  25000,
  'text2video.kling-v1-6.std.10': 50000,
  'text2video.kling-v1-6.pro.5':  50000,
  'text2video.kling-v1-6.pro.10': 100000,
  'text2video.kling-v2-master.std.5':  150000,
  'text2video.kling-v2-master.std.10': 300000,
  'text2video.kling-v2-master.pro.5':  150000,
  'text2video.kling-v2-master.pro.10': 300000,
  'image2video.kling-v1-6.std.5':  25000,
  'image2video.kling-v1-6.std.10': 50000,
  'image2video.kling-v1-6.pro.5':  50000,
  'image2video.kling-v1-6.pro.10': 100000,
  'image2video.kling-v2-master.std.5':  150000,
  'image2video.kling-v2-master.std.10': 300000,
  'image2video.kling-v2-master.pro.5':  150000,
  'image2video.kling-v2-master.pro.10': 300000,
  'extend.kling-v1-6.std.5':  25000,
  'extend.kling-v1-6.pro.5':  50000,
  'extend.kling-v2-master.std.5':  150000,
  'extend.kling-v2-master.pro.5':  150000,
  'lipsync.kling-v1-6.std.5':  15000,
  'lipsync.kling-v1-6.std.10': 15000,
};

export function computeTokenCost(mode: VideoMode, model: VideoModel, quality: VideoQuality, duration: 5|10): number {
  const key = `${mode}.${model}.${quality}.${duration}`;
  const v = VIDEO_PRICING[key];
  if (v == null) throw new Error(`Unsupported combination: ${key}`);
  return v;
}

// Plan a composed long-form video. Base = 10s, each extend = +5s.
// Returns total cost and segment count. The final video gets ffmpeg-trimmed
// to targetDurationSec on assembly, so the user-requested length is exact.
export interface ComposedQuote {
  segments: number;          // total Kling calls (1 base + N extends)
  rawDurationSec: number;    // sum of generated seconds, before trim
  totalCost: number;         // tokens
  baseCost: number;
  extendUnitCost: number;
}

export function computeComposedQuote(
  mode: 'text2video' | 'image2video',
  model: VideoModel,
  quality: VideoQuality,
  targetDurationSec: number,
): ComposedQuote {
  const baseDuration = 10;
  const extendDuration = 5;
  const baseCost   = computeTokenCost(mode, model, quality, baseDuration);
  const extendUnit = computeTokenCost('extend', model, quality, extendDuration);
  const extendCount = Math.ceil(Math.max(0, targetDurationSec - baseDuration) / extendDuration);
  return {
    segments: 1 + extendCount,
    rawDurationSec: baseDuration + extendCount * extendDuration,
    baseCost,
    extendUnitCost: extendUnit,
    totalCost: baseCost + extendCount * extendUnit,
  };
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
