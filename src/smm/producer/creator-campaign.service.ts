// src/smm/producer/creator-campaign.service.ts
import { Injectable } from '@nestjs/common';
import { PgService } from '../../common/services/pg.service';
import {
  SmmCreatorCampaign,
  SmmCreatorVoiceGender,
  SmmCreatorGenre,
  rowToCreatorCampaign,
} from '../entities/smm-creator-campaign.entity';

export interface UpsertCreatorCampaignInput {
  campaignId: string;
  ctaHandle: string;
  ctaLabel?: string;
  voiceGender: SmmCreatorVoiceGender;
  genre?: SmmCreatorGenre;
}

@Injectable()
export class CreatorCampaignService {
  constructor(private readonly pg: PgService) {}

  /**
   * Insert or update creator-mode settings (CTA, voice gender, genre) for a campaign.
   * Defaults: ctaLabel='Подписывайся', genre='dialog' — applied at DB level via
   * column defaults if not provided.
   */
  async upsert(input: UpsertCreatorCampaignInput): Promise<SmmCreatorCampaign> {
    const r = await this.pg.query(
      `INSERT INTO smm_creator_campaign
         (campaign_id, cta_handle, cta_label, voice_gender, genre)
       VALUES ($1, $2, COALESCE($3, 'Подписывайся'), $4, COALESCE($5, 'dialog'))
       ON CONFLICT (campaign_id) DO UPDATE SET
         cta_handle = EXCLUDED.cta_handle,
         cta_label = EXCLUDED.cta_label,
         voice_gender = EXCLUDED.voice_gender,
         genre = EXCLUDED.genre,
         updated_at = now()
       RETURNING *`,
      [input.campaignId, input.ctaHandle, input.ctaLabel ?? null, input.voiceGender, input.genre ?? null],
    );
    return rowToCreatorCampaign(r.rows[0]);
  }

  async getByCampaign(campaignId: string): Promise<SmmCreatorCampaign | null> {
    const r = await this.pg.query(
      `SELECT * FROM smm_creator_campaign WHERE campaign_id = $1`,
      [campaignId],
    );
    return r.rows[0] ? rowToCreatorCampaign(r.rows[0]) : null;
  }

  /**
   * Partial update of branding fields. Only fields explicitly provided are written —
   * undefined leaves the existing value, null clears it. Used by the branding UI
   * (logo upload, slogan edit, default caption) without touching wizard-set
   * cta_handle / voice_gender / genre.
   */
  async updateBranding(
    campaignId: string,
    fields: {
      ctaHandle?: string;
      ctaLabel?: string;
      logoUrl?: string | null;
      ctaSlogan?: string | null;
      publishCaption?: string | null;
      bgColor?: string | null;
      bgImageUrl?: string | null;
    },
  ): Promise<SmmCreatorCampaign | null> {
    const sets: string[] = [];
    const vals: any[] = [];
    let i = 1;
    if (fields.ctaHandle !== undefined) {
      sets.push(`cta_handle = $${i++}`); vals.push(fields.ctaHandle);
    }
    if (fields.ctaLabel !== undefined) {
      sets.push(`cta_label = $${i++}`); vals.push(fields.ctaLabel);
    }
    if (fields.logoUrl !== undefined) {
      sets.push(`logo_url = $${i++}`); vals.push(fields.logoUrl);
    }
    if (fields.ctaSlogan !== undefined) {
      sets.push(`cta_slogan = $${i++}`); vals.push(fields.ctaSlogan);
    }
    if (fields.publishCaption !== undefined) {
      sets.push(`publish_caption = $${i++}`); vals.push(fields.publishCaption);
    }
    if (fields.bgColor !== undefined) {
      sets.push(`bg_color = $${i++}`); vals.push(fields.bgColor);
    }
    if (fields.bgImageUrl !== undefined) {
      sets.push(`bg_image_url = $${i++}`); vals.push(fields.bgImageUrl);
    }
    if (sets.length === 0) return this.getByCampaign(campaignId);
    sets.push(`updated_at = now()`);
    vals.push(campaignId);
    const r = await this.pg.query(
      `UPDATE smm_creator_campaign SET ${sets.join(', ')} WHERE campaign_id = $${i} RETURNING *`,
      vals,
    );
    return r.rows[0] ? rowToCreatorCampaign(r.rows[0]) : null;
  }
}
