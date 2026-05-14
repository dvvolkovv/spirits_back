// src/smm/entities/smm-scenario.entity.ts
export type SmmMood =
  | 'dramatic' | 'inspiring' | 'calm' | 'uplifting' | 'tense' | 'neutral';

export type SmmTtsTier = 'economy' | 'premium';

export type SmmScenarioStatus =
  | 'pending_review' | 'approved' | 'rejected' | 'regenerating';

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
  status: SmmScenarioStatus;
  createdAt: Date;
  updatedAt: Date;
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
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
