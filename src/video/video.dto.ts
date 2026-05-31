// src/video/video.dto.ts
import { IsString, IsOptional, IsNumber, IsIn, IsObject, Min, Max } from 'class-validator';

export type VideoMode = 'text2video' | 'image2video' | 'extend' | 'lipsync';
export type VideoModel = 'kling-v1-6' | 'kling-v2-master';
export type VideoQuality = 'std' | 'pro';
export type VideoStatus = 'pending' | 'processing' | 'ready' | 'failed';

export class CreateVideoJobDto {
  @IsIn(['text2video', 'image2video', 'extend', 'lipsync'])
  mode!: VideoMode;

  @IsOptional() @IsIn(['kling-v1-6', 'kling-v2-master'])
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

  @IsOptional() @IsNumber() @Min(0) @Max(1)
  cfgScale?: number;

  @IsOptional() @IsString()
  sourceImageUrl?: string;

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
  // Retry counter for the segment currently in flight. Reset to 0 every
  // time a segment finishes successfully; bumped when we re-submit after
  // a transient Kling error (e.g. "Internal error"). Capped server-side.
  current_segment_attempt?: number;
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
