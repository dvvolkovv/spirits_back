// src/video/video.dto.ts
import { IsString, IsOptional, IsNumber, IsIn, IsArray, IsBoolean, Min, Max } from 'class-validator';

// Единственный движок — Google, через Gemini Developer API: long-form
// talking-head with native audio + portrait consistency. backlog a0132032.
// До 22.10.2026 это был Veo 3.1, теперь Gemini Omni Flash (Veo 3.1 Google
// закрыл, см. misc/veo.service.ts). Имена моделей 'veo-3.1-fast' и 'veo-3.1'
// остались прежними: их шлют форма, мобилка, ассистенты и они лежат в
// video_jobs. С 24.10.2026 обе значат одно и то же и стоят одинаково.
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

  // Длина ролика. База 8с продлевается по 7с (или ролик клеится из 8с-клипов —
  // см. needsVeoConcat), итог режется ровно до этой длины. По умолчанию 8.
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

  // Разрешение базового сегмента. 1080p даёт детализацию (поры/кожа) —
  // 720p выглядел «пластиково». Цепочка продлений всегда 720p (у Veo это было
  // ограничение API, у Omni — цена: 1080p в 1,5 раза дороже, а продление
  // тарифицируется по 63k), поэтому 1080p эффективен на коротких (≤8с) роликах
  // и в склейке.
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
  // --- Veo/Omni provider (native extend chain — one continuous video, no concat) ---
  provider?: 'kling' | 'veo';   // 'kling' — только в старых строках
  veo_tier?: 'fast' | 'standard';
  veo_aspect_ratio?: '16:9' | '9:16';   // формат базы (extend наследует)
  veo_resolution?: '720p' | '1080p';    // разрешение базы (extend всегда 720p)
  veo_reference_images?: string[];       // URL референс-фото (Ingredients, B)
  // Вместо native extend генерим N независимых 8с-клипов и ffmpeg-concat'им их
  // (с сохранением звука) — когда цепочка продлений невозможна, см.
  // needsVeoConcat. segment_video_urls здесь не используется — клипы
  // складываются в локальные part-файлы по соглашению об именах, см.
  // video.service.composeVeoClips.
  veo_concat?: boolean;
  // Id взаимодействия Omni, чей ролик — всё, что готово на сейчас (у продления
  // ответ — ролик целиком). Следующее продление ссылается на него.
  veo_last_interaction_id?: string | null;
  veo_last_uri?: string | null;   // только старые строки Veo: download uri последнего клипа
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

// Quote: base 8s + N×7s native extends, output trimmed to target.
// User pricing set by the owner 2026-06-03: ~2× cost ("доступная"), i.e. a 24s
// Fast clip ≈ 700₽ ≈ 280k tokens (ref ~2.5₽/1000 tokens; our cost ~360₽/24s).
// → base(8s) 90k, +7s extend 63k.
// 24.10.2026, решение владельца: тариф Standard (Veo 3.1, $0.40/с, 240k за 8с)
// слит с Fast. У Gemini Omni одна модель, и за 'veo-3.1' человек получал бы
// тот же ролик в 2,7 раза дороже. Себестоимость Omni — $0.15/с в 1080p и
// $0.10/с в 720p, то есть как у прежнего Veo Fast или ниже.
export const VEO_BASE_SEC = 8;
export const VEO_EXTEND_SEC = 7;
const VEO_PRICE = { base: 90_000, extendUnit: 63_000 };
const VEO_PRICING: Record<'fast' | 'standard', { base: number; extendUnit: number }> = {
  fast: VEO_PRICE,
  standard: VEO_PRICE,
};

// Omni продлевает ролик максимум до 40 с суммарно (документация Google), а
// цепочка «8с + N×7с» для target 37–60 с выходит за этот предел.
export const OMNI_MAX_CHAIN_SEC = 40;

/**
 * Собирать ли ролик склейкой независимых 8с-клипов вместо цепочки продлений.
 *  - 9:16 длиннее 8с: так было и при Veo (его extend умел только 16:9), путь
 *    проверен живыми роликами, менять его ради Omni незачем.
 *  - 16:9, чья цепочка не помещается в 40 с Omni (target > 36). Решение
 *    владельца 24.10.2026: склейка с ценой по правилу вертикали, N × база.
 * Фронт (VideoCreateForm) считает цену по тому же правилу — держать в паре.
 */
export function needsVeoConcat(aspectRatio: '16:9' | '9:16', targetDurationSec: number): boolean {
  if (aspectRatio === '9:16') return targetDurationSec > VEO_BASE_SEC;
  const extendCount = Math.ceil(Math.max(0, targetDurationSec - VEO_BASE_SEC) / VEO_EXTEND_SEC);
  return VEO_BASE_SEC + extendCount * VEO_EXTEND_SEC > OMNI_MAX_CHAIN_SEC;
}
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

// Склейка (см. needsVeoConcat): вертикаль длиннее 8с — Veo native extend
// работал ТОЛЬКО в 16:9 (API: "Aspect ratio of the input video must be 16:9"),
// и горизонталь длиннее 36с — Omni не продлевает дальше 40с. Такой ролик
// собираем как ffmpeg-concat независимых 8с-клипов — автоматизация ручной
// склейки, о которой писала katya. Каждый клип = полная базовая генерация (нет
// «дешёвого» extend), поэтому цена = N × base (решение владельца 2026-06-06:
// «по факту N×база»). Каждый клип несёт свою порцию реплики
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
