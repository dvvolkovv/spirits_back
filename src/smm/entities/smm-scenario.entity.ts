// src/smm/entities/smm-scenario.entity.ts
export type SmmMood =
  | 'dramatic' | 'inspiring' | 'calm' | 'uplifting' | 'tense' | 'neutral';

export type SmmTtsTier = 'economy' | 'premium';

export type SmmScenarioStatus =
  | 'pending_review' | 'approved' | 'rejected' | 'regenerating';

export type PremiumGenre = 'surreal' | 'pov' | 'cinematic';

export interface SmmDialogTurn {
  speaker: 'hero' | 'assistant';
  text: string;
  tStart: number;
  tEnd: number;
}

export interface SmmBrollPrompt {
  atSec: number;
  type: 'ai_image' | 'stock_video';
  prompt: string;
}

export interface PremiumScene {
  type: 'kling' | 'imagen';
  keyframe_prompt?: string;
  motion_prompt?: string;
  image_prompt?: string;
  duration?: number;
}

export interface SmmScenario {
  id: string;
  campaignId: string;
  title: string;
  assistantRole: string;
  dialog: SmmDialogTurn[];
  mood: SmmMood;
  brollPrompts: SmmBrollPrompt[];
  musicTrackId: string | null;
  ttsTier: SmmTtsTier;
  ttsVoiceId: string | null;
  status: SmmScenarioStatus;
  createdAt: Date;
  updatedAt: Date;
  premiumGenre: PremiumGenre | null;
  klingSceneCount: number;
  scenes: PremiumScene[] | null;
}

export function rowToScenario(row: any): SmmScenario {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    title: row.title,
    assistantRole: row.assistant_role,
    dialog: row.dialog as SmmDialogTurn[],
    mood: row.mood,
    brollPrompts: row.broll_prompts as SmmBrollPrompt[],
    musicTrackId: row.music_track_id ?? null,
    ttsTier: row.tts_tier,
    ttsVoiceId: row.tts_voice_id ?? null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    premiumGenre: row.premium_genre ?? null,
    klingSceneCount: row.kling_scene_count ?? 0,
    scenes: row.scenes_json ?? null,
  };
}
