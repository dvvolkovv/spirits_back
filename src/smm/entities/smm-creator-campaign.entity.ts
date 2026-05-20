// src/smm/entities/smm-creator-campaign.entity.ts
export type SmmCreatorVoiceGender = 'male' | 'female';
export type SmmCreatorGenre = 'dialog' | 'monologue' | 'fact_explanation';

export interface SmmCreatorCampaign {
  campaignId: string;
  ctaHandle: string;
  ctaLabel: string;
  voiceGender: SmmCreatorVoiceGender;
  genre: SmmCreatorGenre;
  createdAt: Date;
  updatedAt: Date;
}

export function rowToCreatorCampaign(row: any): SmmCreatorCampaign {
  return {
    campaignId: row.campaign_id,
    ctaHandle: row.cta_handle,
    ctaLabel: row.cta_label,
    voiceGender: row.voice_gender,
    genre: row.genre,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
