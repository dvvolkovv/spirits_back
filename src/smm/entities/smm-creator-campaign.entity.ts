// src/smm/entities/smm-creator-campaign.entity.ts
export type SmmCreatorVoiceGender = 'male' | 'female';
export type SmmCreatorGenre = 'dialog' | 'monologue' | 'fact_explanation';

export interface SmmCreatorCampaign {
  campaignId: string;
  ctaHandle: string;
  ctaLabel: string;
  voiceGender: SmmCreatorVoiceGender;
  genre: SmmCreatorGenre;
  /** Public URL of the creator's logo (uploaded to MinIO). Null = use Linkeon-only branding. */
  logoUrl: string | null;
  /** Short slogan rendered between logo and handle on the CTA frame. */
  ctaSlogan: string | null;
  /** Default caption pre-filled in PublishModal. User can still edit per publication. */
  publishCaption: string | null;
  /** CSS color or gradient for the video background. Falls back to default gradient. */
  bgColor: string | null;
  /** Public URL of an uploaded background image. Wins over bgColor when set. */
  bgImageUrl: string | null;
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
    logoUrl: row.logo_url ?? null,
    ctaSlogan: row.cta_slogan ?? null,
    publishCaption: row.publish_caption ?? null,
    bgColor: row.bg_color ?? null,
    bgImageUrl: row.bg_image_url ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
